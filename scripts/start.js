#!/usr/bin/env node
/* ============================================
   Launcher — `npm start`
   ------------------------------------------------------------------
   A fresh clone should reach a working agent in one command. Before this
   existed, `npm start` booted the server whatever state the machine was in,
   and getting a usable install meant knowing to run `npm run setup` first.
   Two commands, and the second one is the one nobody reads about.

   So this does the three things that have to happen before the server is
   worth starting, and then starts it:

     1  guard     Node 20+, checked with a message instead of a stack trace
     2  setup     on a first run only, hand over to the setup pipeline
     3  stamp     refresh the service-worker cache version
     4  serve     require server.js, which boots on require

   Everything is in-process. No subprocess, so Ctrl-C, exit codes and signals
   behave exactly as they did when `npm start` was `node server.js`.

   Escape hatches, for when you want the old behaviour:
     npm start -- --no-setup      skip step 2 this once
     TRICORDER_SKIP_SETUP=1       skip step 2 always
     npm run dev                  none of this — straight to the server
   ============================================ */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIN_NODE_MAJOR = 20;

/* ── 1. Node version ──────────────────────────────────────────────────────
   package.json has an `engines` field, but nothing enforces it: this project
   has no dependencies, so nobody ever runs `npm install` and npm never gets
   the chance to check. On Node 18 the failure lands much later, as an error
   about some API being undefined, which reads like a bug in the app. */

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < MIN_NODE_MAJOR) {
    console.error(`
  Tricorder Agent needs Node ${MIN_NODE_MAJOR} or newer.
  You are on Node ${process.versions.node}.

  Install a current Node from https://nodejs.org, or with a version manager:

      nvm install 20 && nvm use 20        # nvm
      fnm install 20 && fnm use 20        # fnm

  Then run npm start again.
`);
    process.exit(1);
}

/* ── 2. First run ─────────────────────────────────────────────────────────
   "First run" means: no .env, and no backend URL in the environment either.
   The second half matters for Docker and systemd, where configuration
   arrives as real environment variables and a .env file never exists — those
   are configured installs, not first runs, and must not be interrupted.

   When setup does run, it is the same pipeline as `npm run setup`: it finds
   the model server, sizes the model to the machine, proves the backend can
   actually call a tool, and writes .env.

   A non-interactive shell (CI, a container, a service manager) gets --yes so
   the launcher can never block on a prompt nobody is there to answer. */

function isFirstRun({
    env = process.env,
    argv = process.argv,
    envPath = path.join(ROOT, '.env'),
    exists = fs.existsSync,
} = {}) {
    if (env.TRICORDER_SKIP_SETUP === '1') return false;
    if (argv.includes('--no-setup')) return false;
    if (env.LLM_BASE_URL || env.LM_STUDIO_URL) return false;
    return !exists(envPath);
}

async function firstRunSetup() {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

    console.log(`
  No .env yet, so this looks like a first run.
  Handing over to the setup pipeline — it will find your model server and
  write the config. Skip it with:  npm start -- --no-setup
`);

    try {
        const setup = require(path.join(ROOT, 'scripts', 'setup.js'));
        await setup.run(interactive ? [] : ['--yes']);
    } catch (err) {
        // Setup is a convenience, not a gate. If it throws, say so and start
        // anyway: the first-run guide in the browser asks the same questions,
        // and a server that boots is more useful than one that refuses to.
        console.error(`
  Setup did not finish: ${err.message}
  Starting the server anyway — the first-run guide in the browser can
  configure it, or run \`npm run setup\` again when you have a moment.
`);
    }
}

/* ── 3 & 4. Stamp, then serve ─────────────────────────────────────────────
   Stamping rewrites CACHE_VERSION in sw.js so browsers do not serve a stale
   app shell after an update. It is cosmetic on a dev machine and best-effort
   everywhere: a read-only checkout should still be able to start. */

function stampVersion() {
    try {
        require(path.join(ROOT, 'scripts', 'stamp-version.js'));
    } catch (err) {
        console.warn(`  [stamp-version] skipped: ${err.message}`);
    }
}

async function main() {
    if (isFirstRun()) await firstRunSetup();
    stampVersion();
    // server.js starts listening on require — there is no exported entry point
    // and no main-module guard, which is what makes the in-process handover
    // work.
    require(path.join(ROOT, 'server.js'));
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`\n  Failed to start: ${err.stack || err.message}\n`);
        process.exit(1);
    });
}

module.exports = { isFirstRun, MIN_NODE_MAJOR };
