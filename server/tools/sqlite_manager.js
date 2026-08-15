/* sqlite_manager — local SQLite operations via Python's stdlib sqlite3.
   SQL-injection guard: write helpers (insert/update/delete/create_table) build
   parameterised statements from structured input; raw execute_query only
   binds values through `params` (never string-concatenated). */

'use strict';

const path = require('path');
const lib = require('./_lib');

const name = 'sqlite_manager';

const schema = {
    type: 'function',
    function: {
        name,
        description: 'Operate on a local SQLite database. Actions: create_db, execute_query(query, '
            + 'params — use ? placeholders), insert(table,data), update(table,data,where?), '
            + 'delete(table,where?), create_table(table,data), export_csv(table), '
            + 'import_csv(table,csv_path), backup(target_path?). db_path must be inside the '
            + 'allowed directories.',
        parameters: {
            type: 'object',
            properties: {
                db_path: { type: 'string', description: 'Path to the .db file' },
                action: { type: 'string', enum: ['create_db', 'execute_query', 'insert', 'update', 'delete', 'create_table', 'export_csv', 'import_csv', 'backup'] },
                query: { type: 'string', description: 'SQL with ? placeholders (execute_query)' },
                params: { type: 'array', description: 'Values bound to the ? placeholders' },
                table: { type: 'string', description: 'Table name (insert/update/delete/create_table/export_csv/import_csv)' },
                data: { type: 'object', description: 'Column->value map (insert/update) or column->type map (create_table)' },
                where: { type: 'object', description: 'Column->value equality filter (update/delete)' },
                csv_path: { type: 'string', description: 'CSV file path (export_csv/import_csv)' },
                target_path: { type: 'string', description: 'Destination .db path (backup; auto-named if omitted)' },
            },
            required: ['db_path', 'action'],
        },
    },
};

const ACTIONS = ['create_db', 'execute_query', 'insert', 'update', 'delete', 'create_table', 'export_csv', 'import_csv', 'backup'];

// Per-action required parameters, checked before any Python spawn.
const REQUIRED_PARAMS = {
    execute_query: ['query'],
    insert: ['table', 'data'],
    update: ['table', 'data'],
    delete: ['table'],
    create_table: ['table', 'data'],
    export_csv: ['table'],
    import_csv: ['table', 'csv_path'],
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(v, label) {
    const s = String(v || '').trim();
    if (!IDENT.test(s)) throw new lib.ToolError(`Invalid ${label}: "${s}" (must be a plain identifier)`, 'BAD_IDENTIFIER');
    return s;
}

const PY = `
import sys, json, sqlite3, csv
d = json.load(sys.stdin)
action = d["action"]
db = d["db_path"]
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
cur = con.cursor()
res = {"ok": True, "action": action}
try:
    if action == "create_db":
        cur.execute("SELECT 1")
        res["path"] = db
    elif action == "execute_query":
        cur.execute(d["query"], d.get("params") or [])
        if cur.description:
            res["rows"] = [dict(r) for r in cur.fetchall()][:1000]
            res["rowCount"] = len(res["rows"])
        else:
            res["rowsAffected"] = cur.rowcount
        con.commit()
    elif action == "insert":
        cols = list(d["data"].keys())
        ph = ",".join("?" for _ in cols)
        cur.execute("INSERT INTO %s (%s) VALUES (%s)" % (d["table"], ",".join(cols), ph),
                    [d["data"][c] for c in cols])
        con.commit(); res["lastRowId"] = cur.lastrowid
    elif action == "update":
        sets = list(d["data"].keys()); where = list((d.get("where") or {}).keys())
        sql = "UPDATE %s SET %s" % (d["table"], ",".join("%s=?" % c for c in sets))
        vals = [d["data"][c] for c in sets]
        if where:
            sql += " WHERE " + " AND ".join("%s=?" % c for c in where)
            vals += [d["where"][c] for c in where]
        cur.execute(sql, vals); con.commit(); res["rowsAffected"] = cur.rowcount
    elif action == "delete":
        where = list((d.get("where") or {}).keys())
        sql = "DELETE FROM %s" % d["table"]
        vals = []
        if where:
            sql += " WHERE " + " AND ".join("%s=?" % c for c in where)
            vals = [d["where"][c] for c in where]
        cur.execute(sql, vals); con.commit(); res["rowsAffected"] = cur.rowcount
    elif action == "create_table":
        cols = ",".join("%s %s" % (c, t) for c, t in d["data"].items())
        cur.execute("CREATE TABLE IF NOT EXISTS %s (%s)" % (d["table"], cols)); con.commit()
        res["table"] = d["table"]
    elif action == "export_csv":
        cur.execute("SELECT * FROM %s" % d["table"])
        rows = cur.fetchall()
        with open(d["csv_path"], "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if rows:
                w.writerow(rows[0].keys())
                for r in rows: w.writerow(list(r))
        res["exported"] = len(rows); res["path"] = d["csv_path"]
    elif action == "import_csv":
        with open(d["csv_path"], newline="", encoding="utf-8") as f:
            rdr = csv.reader(f); header = next(rdr); n = 0
            ph = ",".join("?" for _ in header)
            sql = "INSERT INTO %s (%s) VALUES (%s)" % (d["table"], ",".join(header), ph)
            for row in rdr:
                cur.execute(sql, row); n += 1
        con.commit(); res["imported"] = n
    elif action == "backup":
        dst = sqlite3.connect(d["target_path"])
        con.backup(dst); dst.close(); res["backup"] = d["target_path"]
    print(json.dumps(res))
finally:
    con.close()
`;

async function execute(args, ctx) {
    const action = lib.requireAction(args.action, ACTIONS);
    lib.requireParams(action, args, REQUIRED_PARAMS);
    const dbDir = path.join(lib.WORKSPACE_DIR, 'data');
    lib.ensureDir(dbDir);
    const dbPath = lib.resolvePath(ctx, args.db_path, { label: 'db_path', required: true });
    lib.ensureDir(path.dirname(dbPath));

    const input = { action, db_path: dbPath };

    // backup copies the whole database — no table involved.
    if (['create_db', 'execute_query', 'backup'].includes(action) === false) {
        input.table = ident(args.table, 'table');
    }
    if (action === 'execute_query') {
        if (!args.query) throw new lib.ToolError('query is required', 'MISSING_PARAM');
        // Bound values only ever travel through params — never concatenated.
        input.query = String(args.query);
        input.params = Array.isArray(args.params) ? args.params : [];
    }
    if (['insert', 'update', 'create_table'].includes(action)) {
        if (!args.data || typeof args.data !== 'object') throw new lib.ToolError('data object is required', 'MISSING_PARAM');
        const clean = {};
        for (const [k, v] of Object.entries(args.data)) clean[ident(k, 'column')] = v;
        input.data = clean;
    }
    if (['update', 'delete'].includes(action) && args.where) {
        const clean = {};
        for (const [k, v] of Object.entries(args.where)) clean[ident(k, 'where column')] = v;
        input.where = clean;
    }
    if (['export_csv', 'import_csv'].includes(action)) {
        const def = path.join(dbDir, `${args.table || 'export'}_${lib.timestamp()}.csv`);
        input.csv_path = args.csv_path ? lib.resolvePath(ctx, args.csv_path, { label: 'csv_path' }) : def;
        if (action === 'import_csv' && !require('fs').existsSync(input.csv_path)) {
            throw new lib.ToolError(`CSV not found: ${input.csv_path}`, 'NOT_FOUND');
        }
    }
    if (action === 'backup') {
        // Destination is target_path; the historical csv_path name is kept as a
        // backwards-compatible alias (backup writes a .db copy, not a CSV).
        const raw = args.target_path || args.csv_path;
        input.target_path = raw
            ? lib.resolvePath(ctx, raw, { label: 'target_path' })
            : path.join(dbDir, `${path.basename(dbPath, '.db')}_${lib.timestamp()}.bak.db`);
    }

    return lib.runPython(PY, { ctx, input });
}

module.exports = { name, schema, execute };
