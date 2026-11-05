import { Pool } from "pg";

// Initialize database pool using Vercel's DATABASE_URL environment variable
let pool: Pool;
function getDatabase() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return { pool };
}

type Ref = { collection: string; id: string };
type Op = Ref & { type: "set" | "update"; data: Record<string, unknown>; merge?: boolean };
type Check = Ref & { version: number | null };

const db = getDatabase();
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ID = /^[^/]{1,200}$/;
const OVERLAP_MS = 15000;

const validRef = (r: any): boolean =>
  r && typeof r.collection === "string" && NAME.test(r.collection) && typeof r.id === "string" && ID.test(r.id);
const keyOf = (r: Ref) => r.collection + "/" + r.id;
const isObj = (v: any): boolean => !!v && typeof v === "object" && !Array.isArray(v);
const clone = (v: any): any => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// Resolve Firestore-style field sentinels (serverTimestamp, arrayUnion) against current values
function resolve(cur: any, v: any, now: number): any {
  if (isObj(v) && v.__fsop === "serverTimestamp") return now;
  if (isObj(v) && v.__fsop === "arrayUnion") {
    const arr = Array.isArray(cur) ? clone(cur) : [];
    for (const item of v.values || []) {
      const s = JSON.stringify(item);
      if (!arr.some((x: any) => JSON.stringify(x) === s)) arr.push(clone(item));
    }
    return arr;
  }
  if (Array.isArray(v)) return v.map((x) => resolve(undefined, x, now));
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = resolve(undefined, x, now);
    return out;
  }
  return v;
}

// set+merge: deep-merge maps
function deepMerge(base: Record<string, any>, data: Record<string, any>, now: number) {
  for (const [k, v] of Object.entries(data)) {
    if (isObj(v) && !v.__fsop && isObj(base[k])) deepMerge(base[k], v, now);
    else base[k] = resolve(base[k], v, now);
  }
  return base;
}

// update: replace top-level fields; dotted keys address nested fields
function applyUpdate(base: Record<string, any>, data: Record<string, any>, now: number) {
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

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function sync(since: number) {
  const now = Date.now();
  const from = Number.isFinite(since) && since > 0 ? since - OVERLAP_MS : -1;
  const { rows } = await db.pool.query(
    "SELECT collection, id, data, version FROM league_docs WHERE updated_at > $1",
    [from]
  );
  return json({ now, docs: rows });
}

async function get(refs: Ref[]) {
  if (!Array.isArray(refs) || !refs.every(validRef) || refs.length > 200) return json({ error: "Bad refs" }, 400);
  if (!refs.length) return json({ docs: [] });
  const cols = refs.map((r) => r.collection), ids = refs.map((r) => r.id);
  const { rows } = await db.pool.query(
    `SELECT d.collection, d.id, d.data, d.version FROM league_docs d
     JOIN unnest($1::text[], $2::text[]) AS r(collection, id) ON d.collection = r.collection AND d.id = r.id`,
    [cols, ids]
  );
  return json({ docs: rows });
}

async function commit(ops: Op[], checks: Check[]) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 500) return json({ error: "Bad ops" }, 400);
  if (!ops.every((o) => validRef(o) && (o.type === "set" || o.type === "update") && isObj(o.data)))
    return json({ error: "Bad ops" }, 400);
  checks = Array.isArray(checks) ? checks : [];
  if (!checks.every(validRef)) return json({ error: "Bad checks" }, 400);

  const keys = [...new Set([...ops, ...checks].map(keyOf))].sort();
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    for (const k of keys) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [k]);

    const current = new Map<string, { data: Record<string, any>; version: number } | null>();
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
        return json({ error: "conflict" }, 409);
      }
    }

    const now = Date.now();
    const next = new Map<string, Record<string, any>>();
    for (const op of ops) {
      const k = keyOf(op);
      const cur = next.get(k) ?? (current.get(k) ? clone(current.get(k)!.data) : null);
      if (op.type === "update" && !cur) {
        await client.query("ROLLBACK");
        return json({ error: "No document to update: " + k, code: "not-found" }, 404);
      }
      let data: Record<string, any>;
      if (op.type === "update") data = applyUpdate(cur!, op.data, now);
      else if (op.merge) data = deepMerge(cur || {}, op.data, now);
      else data = resolve(undefined, op.data, now) as Record<string, any>;
      next.set(k, data);
    }

    for (const [k, data] of next) {
      const