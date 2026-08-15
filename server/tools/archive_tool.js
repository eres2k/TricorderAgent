/* archive_tool — create, inspect and extract archives (zip / tar / tar.gz).
   Implementation: Python stdlib zipfile + tarfile. Every path is sandboxed via
   lib.resolvePath, and extraction refuses members that would escape the
   destination directory (zip-slip guard). */

'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./_lib');

const name = 'archive_tool';

// Large trees can take a while to (de)compress.
const timeoutMs = 120000;

const schema = {
    type: 'function',
    function: {
        name,
        description: 'Work with archives (zip, tar, tar.gz/tgz). Actions: '
            + 'create_zip(input_paths or input_dir, output_path — format follows the output '
            + 'extension: .zip or .tar.gz), extract(input_path, output_dir?), list(input_path). '
            + 'All paths must be inside the allowed directories.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['create_zip', 'extract', 'list'] },
                input_path: { type: 'string', description: 'Archive to extract/list' },
                input_paths: { type: 'array', items: { type: 'string' }, description: 'Files to archive (create_zip)' },
                input_dir: { type: 'string', description: 'Directory to archive recursively (create_zip)' },
                output_path: { type: 'string', description: 'Destination archive (.zip, .tar.gz, .tgz, .tar) (create_zip)' },
                output_dir: { type: 'string', description: 'Extraction destination (default: alongside the archive)' },
            },
            required: ['action'],
        },
    },
};

const ACTIONS = ['create_zip', 'extract', 'list'];

const REQUIRED_PARAMS = {
    create_zip: ['output_path'],
    extract: ['input_path'],
    list: ['input_path'],
};

const PY = `
import sys, json, os, zipfile, tarfile
d = json.load(sys.stdin)
action = d["action"]

def is_tar(p):
    return p.endswith((".tar", ".tar.gz", ".tgz", ".tar.bz2"))

def tar_mode(p, write=False):
    if p.endswith((".tar.gz", ".tgz")): return "w:gz" if write else "r:gz"
    if p.endswith(".tar.bz2"): return "w:bz2" if write else "r:bz2"
    return "w" if write else "r:*"

def safe_dest(dest_dir, member_name):
    # zip-slip guard: the joined path must stay inside dest_dir.
    target = os.path.realpath(os.path.join(dest_dir, member_name))
    root = os.path.realpath(dest_dir)
    if target != root and not target.startswith(root + os.sep):
        raise ValueError("archive member escapes destination: %s" % member_name)

if action == "create_zip":
    out = d["output_path"]
    entries = []  # (abs_path, arcname)
    for p in d.get("input_paths") or []:
        entries.append((p, os.path.basename(p)))
    src_dir = d.get("input_dir")
    if src_dir:
        base = os.path.basename(os.path.normpath(src_dir)) or "archive"
        for root, _dirs, files in os.walk(src_dir):
            for f in files:
                full = os.path.join(root, f)
                entries.append((full, os.path.join(base, os.path.relpath(full, src_dir))))
    if is_tar(out):
        with tarfile.open(out, tar_mode(out, write=True)) as tf:
            for full, arc in entries:
                tf.add(full, arcname=arc)
    else:
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
            for full, arc in entries:
                zf.write(full, arcname=arc)
    print(json.dumps({"ok": True, "action": action, "path": out, "entries": len(entries),
                      "bytes": os.path.getsize(out)}))
elif action == "list":
    src = d["input_path"]
    items = []
    if is_tar(src) or (tarfile.is_tarfile(src) and not zipfile.is_zipfile(src)):
        with tarfile.open(src, tar_mode(src)) as tf:
            for m in tf.getmembers()[:1000]:
                items.append({"name": m.name, "size": m.size, "is_dir": m.isdir()})
    else:
        with zipfile.ZipFile(src) as zf:
            for i in zf.infolist()[:1000]:
                items.append({"name": i.filename, "size": i.file_size, "is_dir": i.is_dir()})
    print(json.dumps({"ok": True, "action": action, "path": src, "count": len(items), "entries": items}))
elif action == "extract":
    src = d["input_path"]
    dest = d["output_dir"]
    os.makedirs(dest, exist_ok=True)
    n = 0
    if is_tar(src) or (tarfile.is_tarfile(src) and not zipfile.is_zipfile(src)):
        with tarfile.open(src, tar_mode(src)) as tf:
            for m in tf.getmembers():
                safe_dest(dest, m.name)
            tf.extractall(dest)
            n = len(tf.getnames())
    else:
        with zipfile.ZipFile(src) as zf:
            for nm in zf.namelist():
                safe_dest(dest, nm)
            zf.extractall(dest)
            n = len(zf.namelist())
    print(json.dumps({"ok": True, "action": action, "path": src, "output_dir": dest, "extracted": n}))
`;

async function execute(args, ctx) {
    const action = lib.requireAction(args.action, ACTIONS);
    lib.requireParams(action, args, REQUIRED_PARAMS);
    const input = { action };

    if (action === 'create_zip') {
        const hasPaths = Array.isArray(args.input_paths) && args.input_paths.length > 0;
        if (!hasPaths && !args.input_dir) {
            throw new lib.ToolError('create_zip needs input_paths and/or input_dir', 'MISSING_PARAM', { action, missing: ['input_paths', 'input_dir'] });
        }
        if (hasPaths) {
            input.input_paths = args.input_paths.map((p) => lib.resolvePath(ctx, p, { label: 'input_paths', required: true, mustExist: true }));
        }
        if (args.input_dir) {
            input.input_dir = lib.resolvePath(ctx, args.input_dir, { label: 'input_dir', required: true, mustExist: true });
        }
        input.output_path = lib.resolvePath(ctx, args.output_path, { label: 'output_path', required: true });
        lib.ensureDir(path.dirname(input.output_path));
    } else {
        input.input_path = lib.resolvePath(ctx, args.input_path, { label: 'input_path', required: true, mustExist: true });
        if (action === 'extract') {
            input.output_dir = args.output_dir
                ? lib.resolvePath(ctx, args.output_dir, { label: 'output_dir' })
                : lib.deriveOut(input.input_path, 'extracted', '');
        }
    }

    try {
        return await lib.runPython(PY, { ctx, input, timeout: timeoutMs });
    } catch (e) {
        // A killed compression leaves a half-written archive behind.
        if (e && e.code === 'TIMEOUT' && input.output_path) {
            try { fs.rmSync(input.output_path, { force: true }); } catch { /* best effort */ }
        }
        throw e;
    }
}

module.exports = { name, schema, execute, timeoutMs };
