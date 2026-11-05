// League data client — a small Firestore-compatible adapter backed by Netlify Database
// (via the /api/store function). It exposes the subset of the Firebase API the app uses, so the
// app code keeps working unchanged: doc/collection refs, setDoc/updateDoc, writeBatch,
// runTransaction (optimistic concurrency with automatic retry), onSnapshot (live polling),
// serverTimestamp/arrayUnion, plus an anonymous per-device user id.
const ENDPOINT = '/api/store';
const POLL_MS = 2000, HIDDEN_POLL_MS = 10000;

const cache = new Map();          // "collection/id" → { collection, id, data, version }
const listeners = new Set();
let since = 0, primed = false, timer = null, syncing = null, failures = 0;

const keyOf = r => r.collection + '/' + r.id;
const clone = v => v === undefined ? v : JSON.parse(JSON.stringify(v));

async function call(body) {
    const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let out = null; try { out = await res.json(); } catch (_) {}
    if (!res.ok) {
        const err = new Error((out && out.error) || ('Request failed (' + res.status + ')'));
        err.status = res.status; err.code = res.status === 409 ? 'aborted' : (out && out.code) || 'unavailable';
        throw err;
    }
    return out;
}

const docSnap = (ref, entry) => ({ id: ref.id, ref, exists: () => !!entry, data: () => entry ? clone(entry.data) : undefined });
const colSnap = (name) => {
    const docs = [...cache.values()].filter(e => e.collection === name).map(e => docSnap(e, e));
    return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn) };
};
const fire = (l) => {
    try { l.cb(l.ref.kind === 'doc' ? docSnap(l.ref, cache.get(keyOf(l.ref))) : colSnap(l.ref.collection)); }
    catch (e) { console.error(e); }
};

function ingest(docs) {
    const changed = new Set();
    for (const d of docs || []) {
        const k = keyOf(d), cur = cache.get(k);
        if (!cur || d.version > cur.version) { cache.set(k, d); changed.add(d.collection); changed.add(k); }
    }
    return changed;
}

function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
        try {
            const out = await call({ action: 'sync', since });
            since = out.now;
            const changed = ingest(out.docs);
            const first = !primed; primed = true; failures = 0;
            for (const l of listeners) {
                if (first || changed.has(l.ref.kind === 'doc' ? keyOf(l.ref) : l.ref.collection)) fire(l);
            }
        } catch (e) {
            failures++;
            for (const l of listeners) if (l.err && failures === 1) l.err(e);
            console.error('League data sync failed:', e);
        } finally { syncing = null; }
    })();
    return syncing;
}

function schedule() {
    clearTimeout(timer);
    const base = document.hidden ? HIDDEN_POLL_MS : POLL_MS;
    timer = setTimeout(async () => { await sync(); schedule(); }, Math.min(base * Math.max(1, failures), 30000));
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(); schedule(); } });

const refresh = () => { syncing ? syncing.then(sync) : sync(); };

// ---------- Firebase-compatible API ----------
export const initializeApp = () => ({ name: 'cbbd-league' });
export const getFirestore = () => ({ type: 'netlify-db' });

export const doc = (_db, ...path) => ({ kind: 'doc', collection: path[path.length - 2], id: path[path.length - 1] });
export const collection = (_db, ...path) => ({ kind: 'col', collection: path[path.length - 1] });

export const serverTimestamp = () => ({ __fsop: 'serverTimestamp' });
export const arrayUnion = (...values) => ({ __fsop: 'arrayUnion', values });

const op = (type, ref, data, merge) => ({ type, collection: ref.collection, id: ref.id, data, merge: !!merge });

async function commit(ops, checks) {
    if (!ops.length) return;
    await call({ action: 'commit', ops, checks: checks || [] });
    refresh();
}

export const setDoc = (ref, data, opts) => commit([op('set', ref, data, opts && opts.merge)]);
export const updateDoc = (ref, data) => commit([op('update', ref, data)]);

export function writeBatch() {
    const ops = [];
    const b = {
        set(ref, data, opts) { ops.push(op('set', ref, data, opts && opts.merge)); return b; },
        update(ref, data) { ops.push(op('update', ref, data)); return b; },
        commit: () => commit(ops.splice(0)),
    };
    return b;
}

export async function runTransaction(_db, fn) {
    for (let attempt = 0; ; attempt++) {
        const reads = new Map(), ops = [];
        const tx = {
            async get(ref) {
                const out = await call({ action: 'get', refs: [{ collection: ref.collection, id: ref.id }] });
                const entry = out.docs[0] || null;
                if (entry) ingest([entry]);
                if (!reads.has(keyOf(ref))) reads.set(keyOf(ref), { collection: ref.collection, id: ref.id, version: entry ? entry.version : null });
                return docSnap(ref, entry);
            },
            set(ref, data, opts) { ops.push(op('set', ref, data, opts && opts.merge)); return tx; },
            update(ref, data) { ops.push(op('update', ref, data)); return tx; },
        };
        const result = await fn(tx);
        try {
            await commit(ops, [...reads.values()]);
            return result;
        } catch (e) {
            if (e.status !== 409 || attempt >= 7) throw e;
            await new Promise(r => setTimeout(r, 50 + Math.random() * 150 * (attempt + 1)));
        }
    }
}

export function onSnapshot(ref, cb, err) {
    const l = { ref, cb, err };
    listeners.add(l);
    if (primed) fire(l);
    if (!timer) { sync(); schedule(); }
    return () => listeners.delete(l);
}

// ---------- Anonymous per-device identity (used for ballots and audit entries) ----------
function deviceId() {
    let id = null;
    try { id = localStorage.getItem('cbbd_uid'); } catch (_) {}
    if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, '');
        try { localStorage.setItem('cbbd_uid', id); } catch (_) {}
    }
    return id;
}
export const getAuth = () => ({ currentUser: null });
export async function signInAnonymously(auth) { auth.currentUser = { uid: deviceId(), isAnonymous: true }; return { user: auth.currentUser }; }
export const signInWithCustomToken = signInAnonymously;
