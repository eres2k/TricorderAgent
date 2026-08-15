/* rss_reader — subscribe to and read RSS/Atom feeds.
   Subscriptions persist in ~/.tricorder/rss-feeds.json; seen-item ids are
   cached per feed so get_new_since can report only fresh entries. Fetched
   items are cached in the store for 10 minutes so repeated reads don't hit
   the network; feeds are fetched in parallel (ThreadPoolExecutor, 6 workers).
   Implementation: Python feedparser for fetching/parsing. */

'use strict';

const path = require('path');
const lib = require('./_lib');

const name = 'rss_reader';

const schema = {
    type: 'function',
    function: {
        name,
        description: 'Aggregate RSS/Atom feeds. Actions: add_feed(feed_url), remove_feed(feed_url), '
            + 'get_items(feed_url), get_new_since(feed_url — items unseen since last check), '
            + 'summarize_items(feed_url — titles only), search_feeds(keyword — across subscribed '
            + 'feeds), list_feeds. Results are cached for 10 minutes.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['add_feed', 'remove_feed', 'get_items', 'get_new_since', 'summarize_items', 'search_feeds', 'list_feeds'] },
                feed_url: { type: 'string', description: 'Feed URL (add/remove/get_items/get_new_since/summarize_items)' },
                since: { type: 'string', description: 'ISO date for get_new_since (optional; defaults to last check)' },
                limit: { type: 'number', description: 'Max items (default 20)' },
                keyword: { type: 'string', description: 'Search term (search_feeds)' },
            },
            required: ['action'],
        },
    },
};

const ACTIONS = ['add_feed', 'remove_feed', 'get_items', 'get_new_since', 'summarize_items', 'search_feeds', 'list_feeds'];

// Per-action required parameters, checked before any store/network work.
const REQUIRED_PARAMS = {
    add_feed: ['feed_url'],
    remove_feed: ['feed_url'],
    get_items: ['feed_url'],
    get_new_since: ['feed_url'],
    summarize_items: ['feed_url'],
    search_feeds: ['keyword'],
};

const CACHE_TTL_MS = 10 * 60 * 1000;

// Store path is overridable for tests (never touch the real store in CI).
let STORE = path.join(lib.CONFIG_DIR, 'rss-feeds.json');

function loadStore() { return lib.loadJsonStore(STORE, { feeds: {} }); }
function saveStore(s) { lib.saveJsonStore(STORE, s); }

function validUrl(u) {
    try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; }
}

const FETCH_PY = `
import sys, json
d = json.load(sys.stdin)
import feedparser
from concurrent.futures import ThreadPoolExecutor

def fetch(url):
    items = []
    try:
        f = feedparser.parse(url)
        for e in f.entries[: d.get("limit", 20)]:
            items.append({
                "feed": f.feed.get("title", url),
                "feed_url": url,
                "id": e.get("id") or e.get("link"),
                "title": e.get("title", ""),
                "link": e.get("link", ""),
                "published": e.get("published", e.get("updated", "")),
                "summary": (e.get("summary", "") or "")[:500],
            })
    except Exception as ex:
        items.append({"feed_url": url, "error": str(ex)[:200]})
    return items

urls = d["urls"]
with ThreadPoolExecutor(max_workers=min(6, max(1, len(urls)))) as ex:
    results = list(ex.map(fetch, urls))
out = [item for items in results for item in items]
print(json.dumps({"ok": True, "items": out}))
`;

async function defaultFetchItems(urls, limit, ctx) {
    return lib.runPython(FETCH_PY, { ctx, input: { urls, limit }, requires: { feedparser: 'feedparser' } });
}

// Injectable for tests: the store logic can be exercised without network/Python.
let fetchItems = defaultFetchItems;

// Fetch `urls`, serving subscribed feeds from the in-store cache when fresh
// (TTL 10 min and cached with at least the requested limit). Freshly fetched
// items are written back to the cache of subscribed feeds.
async function fetchWithCache(store, urls, limit, ctx) {
    const now = Date.now();
    const items = [];
    const toFetch = [];
    for (const url of urls) {
        const f = store.feeds[url];
        const c = f && f.cache;
        if (c && c.fetched_at && now - Date.parse(c.fetched_at) < CACHE_TTL_MS && (c.limit || 0) >= limit) {
            items.push(...(c.items || []).slice(0, limit));
        } else {
            toFetch.push(url);
        }
    }
    if (toFetch.length) {
        const r = await fetchItems(toFetch, limit, ctx);
        const fetched = r.items || [];
        let dirty = false;
        for (const url of toFetch) {
            const forUrl = fetched.filter((i) => i.feed_url === url && !i.error);
            if (store.feeds[url]) {
                store.feeds[url].cache = { fetched_at: new Date(now).toISOString(), limit, items: forUrl };
                dirty = true;
            }
            items.push(...forUrl);
        }
        if (dirty) saveStore(store);
    }
    return items;
}

async function execute(args, ctx) {
    const action = lib.requireAction(args.action, ACTIONS);
    lib.requireParams(action, args, REQUIRED_PARAMS);
    const store = loadStore();

    if (action === 'list_feeds') {
        return { ok: true, feeds: Object.values(store.feeds).map((f) => ({ url: f.url, added: f.added, lastChecked: f.lastChecked })) };
    }

    if (action === 'add_feed') {
        if (!validUrl(args.feed_url)) throw new lib.ToolError('A valid http(s) feed_url is required', 'BAD_PARAM');
        store.feeds[args.feed_url] = store.feeds[args.feed_url] || { url: args.feed_url, added: new Date().toISOString(), seen: [], lastChecked: null };
        saveStore(store);
        return { ok: true, action, feed_url: args.feed_url, total_feeds: Object.keys(store.feeds).length };
    }

    if (action === 'remove_feed') {
        if (!store.feeds[args.feed_url]) throw new lib.ToolError(`Not subscribed: ${args.feed_url}`, 'NOT_FOUND');
        delete store.feeds[args.feed_url];
        saveStore(store);
        return { ok: true, action, feed_url: args.feed_url };
    }

    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 100);

    if (action === 'get_items' || action === 'summarize_items') {
        if (!validUrl(args.feed_url) && !store.feeds[args.feed_url]) throw new lib.ToolError('feed_url required', 'MISSING_PARAM');
        const items = await fetchWithCache(store, [args.feed_url], limit, ctx);
        if (action === 'summarize_items') {
            return { ok: true, count: items.length, titles: items.map((i) => i.title) };
        }
        return { ok: true, count: items.length, items };
    }

    if (action === 'get_new_since') {
        const feed = store.feeds[args.feed_url];
        if (!feed) throw new lib.ToolError(`Not subscribed: ${args.feed_url}. add_feed first.`, 'NOT_FOUND');
        const items = await fetchWithCache(store, [args.feed_url], limit, ctx);
        const seen = new Set(feed.seen || []);
        let fresh = items.filter((i) => i.id && !seen.has(i.id));
        if (args.since) {
            const since = Date.parse(args.since);
            if (!Number.isNaN(since)) fresh = fresh.filter((i) => !i.published || Date.parse(i.published) >= since);
        }
        feed.seen = [...seen, ...fresh.map((i) => i.id)].slice(-500);
        feed.lastChecked = new Date().toISOString();
        saveStore(store);
        return { ok: true, count: fresh.length, items: fresh };
    }

    if (action === 'search_feeds') {
        const kw = String(args.keyword || '').toLowerCase();
        const urls = Object.keys(store.feeds);
        if (urls.length === 0) return { ok: true, count: 0, items: [], note: 'No subscribed feeds.' };
        const items = await fetchWithCache(store, urls, limit, ctx);
        const hits = items.filter((i) =>
            (i.title || '').toLowerCase().includes(kw) || (i.summary || '').toLowerCase().includes(kw));
        return { ok: true, keyword: args.keyword, count: hits.length, items: hits.slice(0, limit) };
    }

    throw new lib.ToolError(`Unhandled action ${action}`, 'BAD_ACTION');
}

module.exports = {
    name, schema, execute,
    // Test hooks: swap out the network fetcher / relocate the JSON store.
    _setFetchItems(fn) { fetchItems = fn || defaultFetchItems; },
    _setStorePath(p) { STORE = p || path.join(lib.CONFIG_DIR, 'rss-feeds.json'); },
};
