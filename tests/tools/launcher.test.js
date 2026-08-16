/* The launcher — scripts/start.js.

   `npm start` runs setup on a first run so a fresh clone needs one command
   instead of two. The whole risk of that convenience is misfiring: running an
   interactive wizard in front of an install that was already configured, or
   in a container where nobody can answer it. So what is worth locking down is
   the decision itself — when the launcher hands over to setup and, more
   importantly, when it must not. */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const launcher = require('../../scripts/start.js');

const never = () => false;   // .env does not exist
const always = () => true;   // .env exists

test('a fresh clone is a first run', () => {
    assert.strictEqual(
        launcher.isFirstRun({ env: {}, argv: [], exists: never }),
        true,
    );
});

test('an existing .env is not a first run', () => {
    assert.strictEqual(
        launcher.isFirstRun({ env: {}, argv: [], exists: always }),
        false,
    );
});

test('a backend configured through the environment is not a first run', () => {
    // Docker, systemd and CI pass configuration as real environment variables
    // and never write a .env. Those installs are configured, not fresh, and
    // interrupting them with a wizard would be the worst version of this
    // feature.
    for (const key of ['LLM_BASE_URL', 'LM_STUDIO_URL']) {
        assert.strictEqual(
            launcher.isFirstRun({ env: { [key]: 'http://127.0.0.1:1234' }, argv: [], exists: never }),
            false,
            `${key} should suppress first-run setup`,
        );
    }
});

test('both escape hatches work', () => {
    assert.strictEqual(
        launcher.isFirstRun({ env: {}, argv: ['--no-setup'], exists: never }),
        false,
        '--no-setup should suppress first-run setup',
    );
    assert.strictEqual(
        launcher.isFirstRun({ env: { TRICORDER_SKIP_SETUP: '1' }, argv: [], exists: never }),
        false,
        'TRICORDER_SKIP_SETUP=1 should suppress first-run setup',
    );
});

test('the Node floor matches what package.json advertises', () => {
    // These drifting apart is how you get an `engines` field promising one
    // thing and a runtime guard enforcing another. Nothing runs `npm install`
    // in a zero-dependency project, so the guard is the only real check.
    const pkg = require('../../package.json');
    const declared = parseInt(String(pkg.engines.node).replace(/[^\d]/g, ''), 10);
    assert.strictEqual(launcher.MIN_NODE_MAJOR, declared);
});

/* ── Opening a browser ────────────────────────────────────────────────────

   Ending `npm start` with the app on screen is only right on a machine
   someone is sitting at. Getting it wrong is loud and hard to ignore: a
   container spraying xdg-open failures, or a systemd unit trying to open a
   tab on a box with no display. So the cases where it must NOT fire are what
   is worth pinning down. */

const desktop = { env: {}, argv: [], platform: 'darwin', isTTY: true };

test('a desktop terminal opens the app', () => {
    assert.strictEqual(launcher.shouldOpenBrowser(desktop), true);
    assert.strictEqual(launcher.shouldOpenBrowser({ ...desktop, platform: 'win32' }), true);
    assert.strictEqual(
        launcher.shouldOpenBrowser({ ...desktop, platform: 'linux', env: { DISPLAY: ':0' } }),
        true,
    );
    assert.strictEqual(
        launcher.shouldOpenBrowser({ ...desktop, platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }),
        true,
        'Wayland counts as a desktop too',
    );
});

test('nothing opens where nobody is watching', () => {
    const cases = [
        ['not a terminal (CI, systemd, piped logs)', { ...desktop, isTTY: false }],
        ['over SSH', { ...desktop, env: { SSH_CONNECTION: '10.0.0.1 22' } }],
        ['over SSH (tty variant)', { ...desktop, env: { SSH_TTY: '/dev/pts/0' } }],
        ['headless Linux', { ...desktop, platform: 'linux', env: {} }],
    ];
    for (const [why, opts] of cases) {
        assert.strictEqual(launcher.shouldOpenBrowser(opts), false, `should not open: ${why}`);
    }
});

test('both opt-outs work', () => {
    assert.strictEqual(launcher.shouldOpenBrowser({ ...desktop, argv: ['--no-open'] }), false);
    assert.strictEqual(launcher.shouldOpenBrowser({ ...desktop, env: { TRICORDER_NO_BROWSER: '1' } }), false);
});
