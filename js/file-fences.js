/* ============================================
   Streaming file blocks — fenced `file=` code blocks in the reply text
   ------------------------------------------------------------------
   Delivery channel for project files that actually STREAMS on backends
   that buffer tool-call arguments (LM Studio): instead of packing a whole
   file into one write_file JSON blob (buffered silently for minutes, prone
   to broken escaping, size-capped), the model writes it as a normal fenced
   code block whose info line carries the target path:

       ```html file=~/tricorder-workspace/code/page.html
       <!DOCTYPE html>
       ...
       ```

   Content arrives as ordinary streaming deltas, so the operator watches
   the file grow token by token. The client (js/llm.js) strips the block
   from the visible reply, feeds it to the live file panel while streaming,
   and on completion saves it through the regular write_file machinery
   (including the operator-approval gate).

   This module is the pure parser: it takes the (possibly still-streaming,
   incomplete) reply text and splits it into visible text + file blocks.
   Loaded as a classic <script> in the browser (before llm.js) and
   require()-d under Node for tests.
   ============================================ */

const TricorderFileFences = (() => {
    // Opening line: ``` + optional language + whitespace + file=<path> (or
    // path=<path>). The path may be quoted to allow spaces. Nothing else may
    // follow, so ordinary annotated fences never match by accident.
    const OPEN_RE = /^```([A-Za-z0-9_+#.\-]*)[ \t]+(?:file|path)=(?:"([^"]+)"|'([^']+)'|(\S+))[ \t]*$/;

    // Cheap pre-check so hot streaming paths can skip the full parse.
    const HINT_RE = /```[^\n]*[ \t](?:file|path)=/;
    function mayContainFileBlock(text) {
        return typeof text === 'string' && HINT_RE.test(text);
    }

    function defaultMarker(file) {
        return file.complete
            ? `📄 \`${file.path}\``
            : `📄 \`${file.path}\` …`;
    }

    // Parse reply text (complete or mid-stream) into:
    //   { visible, files: [{ path, lang, content, complete, raw }] }
    // Each file block is replaced in `visible` by markerFn(file, index) —
    // one short line instead of hundreds of code lines. markerFn returning
    // null/undefined keeps the original block in the visible text (used to
    // restore code the operator must not lose, e.g. after a denied write).
    // A block still open at end-of-text yields complete:false with the
    // content streamed so far.
    function parse(text, markerFn) {
        if (typeof text !== 'string' || !text) return { visible: text || '', files: [] };
        if (!HINT_RE.test(text)) return { visible: text, files: [] };
        const mark = typeof markerFn === 'function' ? markerFn : defaultMarker;
        const src = text.indexOf('\r') !== -1 ? text.replace(/\r\n/g, '\n') : text;
        const lines = src.split('\n');
        const visible = [];
        const files = [];
        let cur = null;      // open file block: { path, lang, lines, rawLines }
        let inPlain = false; // inside an ordinary fenced block — pass through

        const finalize = (complete) => {
            const file = {
                path: cur.path,
                lang: cur.lang,
                content: cur.lines.join('\n'),
                complete,
                raw: cur.rawLines.join('\n'),
            };
            files.push(file);
            const m = mark(file, files.length - 1);
            if (m == null) visible.push(...cur.rawLines);
            else if (m !== '') visible.push(m);
            cur = null;
        };

        for (const line of lines) {
            if (cur) {
                cur.rawLines.push(line);
                if (line.trimEnd() === '```') { finalize(true); continue; }
                cur.lines.push(line);
                continue;
            }
            if (inPlain) {
                visible.push(line);
                if (line.trimStart().startsWith('```')) inPlain = false;
                continue;
            }
            const m = OPEN_RE.exec(line);
            if (m) {
                cur = { lang: m[1] || '', path: m[2] || m[3] || m[4], lines: [], rawLines: [line] };
                continue;
            }
            visible.push(line);
            if (line.trimStart().startsWith('```')) inPlain = true;
        }
        if (cur) finalize(false);

        return { visible: visible.join('\n'), files };
    }

    return { parse, mayContainFileBlock };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = TricorderFileFences;
}
if (typeof window !== 'undefined') {
    window.TricorderFileFences = TricorderFileFences;
}
