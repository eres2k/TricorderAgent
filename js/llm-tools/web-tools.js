/* Native tools — Web: search, fetch, scrape, raw HTTP, fact checking.
   Executed server-side via /api/tools/execute (see server.js). */

TricorderNativeTools.register([
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the web (DuckDuckGo). Returns {title, url, snippet} results; include_images adds embeddable image URLs (use as ![title](image)). Use for any live information — news, prices, releases.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search query' },
                    include_images: { type: 'boolean', description: 'Also search images (slower, default false)' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: 'Fetch and read the text content of a web page. Returns the page title and extracted text. Use to read articles, documentation, or any web content.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'The URL to fetch' }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'scrape_url',
            description: 'Fetch a URL and extract structured content: title, meta tags (incl. OpenGraph/Twitter), headings (h1-h6), tables (with headers and rows), links, images, JSON-LD, and main text. Use for data extraction, structured research, or when web_fetch gives you unusable flat text. Specify `include` to limit the payload.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to scrape' },
                    include: {
                        type: 'array',
                        items: { type: 'string', enum: ['meta', 'headings', 'tables', 'links', 'images', 'jsonld', 'text'] },
                        description: 'Which sections to extract. Omit to get everything.'
                    },
                    max_bytes: { type: 'number', description: 'Max bytes to download (default 300000, max 1000000)' }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'http_request',
            description: 'Make an arbitrary HTTP request. Supports GET/POST/PUT/DELETE with custom headers and body. Returns status code, response headers, and body text. Use for REST APIs when web_fetch is insufficient.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Full URL to request' },
                    method: { type: 'string', enum: ['GET','POST','PUT','DELETE','PATCH','HEAD'], description: 'HTTP method (default GET)' },
                    headers: { type: 'object', description: 'Optional headers object', additionalProperties: { type: 'string' } },
                    body: { type: 'string', description: 'Optional request body (string or JSON-stringified)' }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'fact_check',
            description: 'Verify a factual claim using multi-source web research. Searches multiple independent sources, classifies them by reliability tier (Tier 1: Reuters/Bloomberg/AP/NYT/Axios, Tier 2: Forbes/CNBC/TechCrunch/Wikipedia, Tier 3: Medium/tech blogs), fetches full articles, cross-verifies facts, and checks timeline plausibility. Returns a structured verification report with confidence score, source breakdown, and contradictions. Use proactively at MED and MAX effort when making factual claims about current events, business deals, tech releases, or anything where accuracy is critical.',
            parameters: {
                type: 'object',
                properties: {
                    claim: { type: 'string', description: 'The factual claim or statement to verify (e.g. "Microsoft acquired Activision Blizzard for $69 billion in 2023")' },
                    depth: { type: 'string', enum: ['quick', 'standard', 'deep'], description: 'Verification depth: quick (2 searches, snippet-only), standard (3 searches + fetch top articles), deep (5 searches + fetch + full cross-verification + timeline analysis). Default: standard' },
                    context: { type: 'string', description: 'Optional topic context to guide search (e.g. "tech industry", "geopolitics", "medical research")' }
                },
                required: ['claim']
            }
        }
    }
]);
