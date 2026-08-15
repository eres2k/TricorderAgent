#!/usr/bin/env node
/**
 * Generate js/llm-tools/extended-tools.js from the authoritative schemas in
 * server/tools/<name>.js.
 *
 * The browser sends tool schemas to the model; the server executes the calls.
 * Both sides must describe the SAME tool, or the model calls a parameter the
 * executor never reads. Rather than maintaining two copies by hand, the
 * browser copy is generated from the server modules — the single source of
 * truth — and tests/tools/consistency.test.js re-runs this generator and
 * fails if the checked-in file has drifted.
 *
 * Usage: node scripts/gen-extended-tools.js          (write the file)
 *        node scripts/gen-extended-tools.js --check  (exit 1 if out of date)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'js', 'llm-tools', 'extended-tools.js');

function render() {
    const registry = require(path.join(ROOT, 'server', 'tools', 'index.js'));
    const body = JSON.stringify(registry.schemas, null, 4)
        .split('\n')
        .map((l, i) => (i === 0 ? l : '    ' + l))
        .join('\n');

    return `/* Native tools — Extended toolbelt.

   GENERATED FILE — do not edit by hand.
   Run \`npm run build:tools\` after changing any schema in server/tools/.

   These mirror the authoritative schemas in server/tools/<name>.js VERBATIM.
   The browser sends them to the model as \`tools\`; the server executes them
   through the tool dispatcher's default case → the server/tools registry.
   tests/tools/consistency.test.js asserts the two stay in lockstep.

   This file is also require()-able under Node (it module.exports the array). */

(function () {
    'use strict';

    const EXTENDED_TOOL_SCHEMAS = ${body};

    if (typeof TricorderNativeTools !== 'undefined' && TricorderNativeTools.register) {
        TricorderNativeTools.register(EXTENDED_TOOL_SCHEMAS);
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = EXTENDED_TOOL_SCHEMAS;
    }
})();
`;
}

function main() {
    const next = render();
    const check = process.argv.includes('--check');
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current === next) {
        console.log('gen-extended-tools: up to date');
        return 0;
    }
    if (check) {
        console.error('gen-extended-tools: js/llm-tools/extended-tools.js is out of date.');
        console.error('Run: npm run build:tools');
        return 1;
    }
    fs.writeFileSync(OUT, next);
    console.log(`gen-extended-tools: wrote ${path.relative(ROOT, OUT)}`);
    return 0;
}

if (require.main === module) process.exit(main());
module.exports = { render };
