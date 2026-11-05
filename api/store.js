import pg from "pg";
const { Pool } = pg;

let pool;
function getDatabase() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return { pool };
}

const db = getDatabase();
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ID = /^[^/]{1,200}$/;
const OVERLAP_MS = 15000;

const validRef = (r) =>
  r && typeof r.collection === "string" && NAME.test(r.collection) && typeof r.id === "string" && ID.test(r.id);
const keyOf = (r) => r.collection + "/" + r.id;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function resolve(cur, v, now) {
  if (isObj(v) && v.__fsop === "serverTimestamp") return now;
  if (isObj(v) && v.__fsop === "arrayUnion") {
    const arr = Array.isArray(cur) ? clone(cur) : [];
    for (const item of v.values || []) {
      const s = JSON.stringify(item);
      if (!arr.some((x) => JSON.stringify(x) === s)) arr.push(clone(item));
    }
    return arr;
  }
  if (Array.isArray(v)) return v.map((x) => resolve(undefined, x, now));
  if (isObj(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = resolve(undefined, x, now);
    return out;
  }
  return v;
}

function deepMerge(base, data, now) {
  for (const [k, v] of Object.entries(data)) {
    if (isObj(v) && !v.__fsop && isObj(base[k])) deepMerge(base[k], v, now);
    else base[k] = resolve(base[k], v, now);
  }
  return base;
}

function applyUpdate(base, data, now) {
  for (const [k, v] of Object.entries(data)) {
    const parts = k.split(".");
    let target = base;
    for (const p of parts.slice(0, -1)) {
      if (!isObj(target[p])) target[p] = {};
      target = target[p];
    }
    const last = parts[parts.length - 1];
    target[last] = resolve(target[last], v, now);
  }
  return base;
}

async function sync(since) {
  const now = Date.now();
  const from = Number.isFinite(since) && since > 0 ? since - OVERLAP_MS : -1;
  const { rows } = await db.pool.query(
    "SELECT collection, id, data, version FROM league_docs WHERE updated_at > $1",
    [from]
  );
  return { now, docs: rows };
}

async function get(refs) {
  if (!Array.isArray(refs) || !refs.every(validRef) || refs.length > 200) throw { status: 400, message: "Bad refs" };
  if (!refs.length) return { docs: [] };
  const cols = refs.map((r) => r.collection), ids = refs.map((r) => r.id);
  const { rows } = await db.pool.query(
    `SELECT d.collection, d.id, d.data, d.version FROM league_docs d
     JOIN unnest($1::text[], $2::text[]) AS r(collection, id) ON d.collection = r.collection AND d.id = r.id`,
    [cols, ids]
  );
  return { docs: rows };
}

async function commit(ops, checks) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 500) throw { status: 400, message: "Bad ops" };
  if (!ops.every((o) => validRef(o) && (o.type === "set" || o.type === "update") && isObj(o.data)))
    throw { status: 400, message: "Bad ops" };
  checks = Array.isArray(checks) ? checks : [];
  if (!checks.every(validRef)) throw { status: 400, message: "Bad checks" };

  const keys = [...new Set([...ops, ...checks].map(keyOf))].sort();
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    for (const k of keys) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [k]);

    const current = new Map();
    for (const k of keys) {
      const i = k.indexOf("/");
      const { rows } = await client.query(
        "SELECT data, version FROM league_docs WHERE collection = $1 AND id = $2",
        [k.slice(0, i), k.slice(i + 1)]
      );
      current.set(k, rows[0] ? { data: rows[0].data, version: rows[0].version } : null);
    }

    for (const c of checks) {
      const cur = current.get(keyOf(c));
      if ((cur ? cur.version : null) !== (c.version ?? null)) {
        await client.query("ROLLBACK");
        throw { status: 409, message: "conflict" };
      }
    }

    const now = Date.now();
    const next = new Map();
    for (const op of ops) {
      const k = keyOf(op);
      const cur = next.get(k) ?? (current.get(k) ? clone(current.get(k).data) : null);
      if (op.type === "update" && !cur) {
        await client.query("ROLLBACK");
        throw { status: 404, message: "No document to update: " + k };
      }
      let data;
      if (op.type === "update") data = applyUpdate(cur, op.data, now);
      else if (op.merge) data = deepMerge(cur || {}, op.data, now);
      else data = resolve(undefined, op.data, now);
      next.set(k, data);
    }

    for (const [k, data] of next) {
      const i = k.indexOf("/");
      await client.query(
        `INSERT INTO league_docs (collection, id, data, version, updated_at) VALUES ($1, $2, $3::jsonb, 1, $4)
         ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, version = league_docs.version + 1, updated_at = EXCLUDED.updated_at`,
        [k.slice(0, i), k.slice(i + 1), JSON.stringify(data), now]
      );
    }
    await client.query("COMMIT");
    return { ok: true, now };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }
  }

  try {
    if (body.action === "sync") {
      const result = await sync(Number(body.since) || 0);
      return res.status(200).json(result);
    }
    if (body.action === "get") {
      const result = await get(body.refs);
      return res.status(200).json(result);
    }
    if (body.action === "commit") {
      const result = await commit(body.ops, body.checks);
      return res.status(200).json(result);
    }
    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    if (e && e.status) {
      return res.status(e.status).json({ error: e.message });
    }
    console.error("store error", e);
    return res.status(500).json({ error: "Database error" });
  }
}