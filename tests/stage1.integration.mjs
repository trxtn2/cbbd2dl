// Stage 1 end-to-end integration test.
// Mounts the real index.html app (Vue + the actual setup() code) in jsdom against an in-memory
// Firestore fake that implements optimistic-concurrency transactions (like real Firestore), then drives:
// registration → admin validation → WPR → tier finalization → snake draft (pause/undo/concurrency/finalize).
//
// Requirements (dev only, not shipped): jsdom and vue. Example:
//   mkdir -p /tmp/t && cd /tmp/t && npm i jsdom vue && NODE_PATH=/tmp/t/node_modules node /path/to/tests/stage1.integration.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.NODE_PATH ? process.env.NODE_PATH + '/' : import.meta.url);
const { JSDOM } = require('jsdom');
const vueSrc = readFileSync(require.resolve('vue/dist/vue.global.js'), 'utf8');

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const engineSrc = html.match(/<script id="cbbd-engine">([\s\S]*?)<\/script>/)[1];
const appSrc = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*$/mg, '');
const body = html.slice(html.indexOf('<body'), html.indexOf('<!-- CBBD Stage 1 Engine'));

// ---------------- In-memory Firestore fake ----------------
function makeFirestore() {
    const store = new Map(), versions = new Map(), listeners = [];
    const SERVER_TS = { __ts: true }, isUnion = v => v && v.__union;
    const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    const parentOf = p => p.split('/').slice(0, -1).join('/');
    // Snapshots are immutable at read time, like real Firestore.
    const snapDoc = path => { const has = store.has(path), d = clone(store.get(path)); return { id: path.split('/').pop(), exists: () => has, data: () => clone(d) }; };
    const notify = () => queueMicrotask(() => listeners.forEach(l => l.fire()));
    const resolve = (cur, v) => v === SERVER_TS ? Date.now() : isUnion(v) ? [...(Array.isArray(cur) ? cur : []), ...clone(v.items)] : clone(v);
    const checkUndef = (o, path) => { JSON.stringify(o, (k, v) => { if (v === undefined) throw new Error(`Unsupported field value: undefined (${path}.${k})`); return v; }); };
    const write = (op) => {
        const { path, data, mode } = op; checkUndef(data, path);
        const cur = store.get(path);
        if (mode === 'update' && !cur) throw new Error('No document to update: ' + path);
        const base = mode === 'set' ? {} : clone(cur) || {};
        for (const [k, v] of Object.entries(data)) base[k] = resolve(base[k], v);
        store.set(path, base); versions.set(path, (versions.get(path) || 0) + 1);
    };
    const api = {
        store, SERVER_TS, stats: { txRetries: 0 }, barrier: null,
        getFirestore: () => ({}),
        doc: (_db, ...seg) => ({ path: seg.join('/') }),
        collection: (_db, ...seg) => ({ path: seg.join('/'), isCol: true }),
        serverTimestamp: () => SERVER_TS,
        arrayUnion: (...items) => ({ __union: true, items }),
        setDoc: async (ref, data, opts) => { write({ path: ref.path, data, mode: opts && opts.merge ? 'merge' : 'set' }); notify(); },
        updateDoc: async (ref, data) => { write({ path: ref.path, data, mode: 'update' }); notify(); },
        writeBatch: () => { const ops = []; return {
            set: (r, d, o) => ops.push({ path: r.path, data: d, mode: o && o.merge ? 'merge' : 'set' }),
            update: (r, d) => ops.push({ path: r.path, data: d, mode: 'update' }),
            commit: async () => { ops.forEach(write); notify(); } }; },
        onSnapshot: (ref, cb) => {
            const l = { fire: () => {
                if (ref.isCol) { const docs = [...store.keys()].filter(p => parentOf(p) === ref.path).map(snapDoc); cb({ forEach: f => docs.forEach(f), size: docs.length }); }
                else cb(snapDoc(ref.path));
            } };
            listeners.push(l); queueMicrotask(l.fire); return () => {};
        },
        // Optimistic concurrency: reads record versions; commit fails & retries if any read doc changed.
        runTransaction: async (_db, fn) => {
            for (let attempt = 0; attempt < 5; attempt++) {
                const reads = new Map(), ops = [];
                const tx = {
                    get: async (ref) => {
                        await new Promise(r => setTimeout(r, 1));
                        // Optional race barrier: hold N transactions until all have read the same doc version.
                        const bar = api.barrier;
                        if (bar && ref.path.endsWith(bar.suffix) && bar.waiting.length < bar.n) {
                            const snap = snapDoc(ref.path); reads.set(ref.path, versions.get(ref.path) || 0);
                            await new Promise(r => { bar.waiting.push(r); if (bar.waiting.length === bar.n) { api.barrier = null; bar.waiting.forEach(f => f()); } });
                            return snap;
                        }
                        reads.set(ref.path, versions.get(ref.path) || 0); return snapDoc(ref.path);
                    },
                    set: (r, d, o) => { ops.push({ path: r.path, data: d, mode: o && o.merge ? 'merge' : 'set' }); return tx; },
                    update: (r, d) => { ops.push({ path: r.path, data: d, mode: 'update' }); return tx; },
                };
                const result = await fn(tx);
                const stale = [...reads].some(([p, v]) => (versions.get(p) || 0) !== v);
                if (stale) { api.stats.txRetries++; continue; }
                ops.forEach(write); notify(); return result;
            }
            throw new Error('Transaction failed after retries');
        },
        initializeApp: () => ({}),
        getAuth: () => ({ currentUser: { uid: 'uid-' + Math.random().toString(36).slice(2, 8) } }),
        signInAnonymously: async () => {}, signInWithCustomToken: async () => {},
    };
    return api;
}

// ---------------- Boot the app in jsdom ----------------
const fb = makeFirestore();
const dom = new JSDOM(`<!DOCTYPE html><html><head></head>${body}</body></html>`, { runScripts: 'outside-only', url: 'https://cbbd.test/' });
const w = dom.window;
w.__fb = fb; w.console = console;
w.eval(vueSrc);
w.eval(engineSrc);
w.eval(`(async () => { const { ${Object.keys(fb).filter(k => typeof fb[k] === 'function').join(', ')} } = window.__fb;\n${appSrc}\n })()`);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
await tick(30);
const vm = w.document.querySelector('#app').__vue_app__._instance.proxy;
const E = w.CBBDEngine;

let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { failed++; console.log('  ✗', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); } };
const confirmYes = async (reason = 'test reason') => { assert.ok(vm.confirmState.open, 'confirm dialog should be open'); vm.confirmState.reason = reason; await vm.runConfirm(); await tick(); };
const login = async (pin, name = 'Tester') => { vm.operatorInput = name; vm.pinInput = pin; vm.attemptLogin(); await tick(); };
const logs = () => [...fb.store.entries()].filter(([p]) => p.includes('/adminLogs/')).map(([, v]) => v);
const playersDocs = () => [...fb.store.entries()].filter(([p]) => p.includes('/players/')).map(([, v]) => v);

const register = async (i) => {
    vm.openRegistration();
    const lvl = (i % 5) + 1;
    Object.assign(vm.regDraft, { name: 'Player ' + String(i).padStart(2, '0'), memberStatus: 'Active', instrument: 'Trumpet', section: 'Brass', years: (i % 12) + 1,
        heightFt: 5, heightIn: i % 12, position: ['PG', 'SG', 'SF', 'PF', 'C'][i % 5], photo: 'data:image/jpeg;base64,AAAA' });
    E.ALL_KEYS.forEach((k, j) => vm.regDraft.assessment[k] = ((lvl + j) % 5) + 1);
    for (let s = 1; s < 6; s++) vm.nextRegStep();
    assert.equal(vm.regStep, 6, 'wizard should reach review: ' + vm.regError);
    await vm.submitRegistration(); await tick();
};

console.log('\nRegistration & assessment');
await test('existing legacy player record is preserved (not overwritten)', async () => {
    await fb.setDoc(fb.doc(null, 'artifacts', 'cbbd-league-v2', 'public', 'data', 'players', 'p_legacy'),
        { id: 'p_legacy', name: 'Legacy Larry', instrument: 'Tuba', years: 4, height: "5'9 - 5'11", position: 'C', skill: 4, photo: null, team: null, deleted: false, totalPoints: 0 });
    await tick();
    assert.equal(vm.players.length, 1);
});
await test('wizard blocks incomplete questionnaire', async () => {
    vm.openRegistration(); Object.assign(vm.regDraft, { name: 'Incomplete Ian', memberStatus: 'Active', instrument: 'Flute', years: 2, heightFt: 5, heightIn: 6, position: 'PG' });
    vm.nextRegStep(); vm.nextRegStep(); vm.nextRegStep(); vm.nextRegStep();
    assert.equal(vm.regStep, 4); assert.match(vm.regError, /Answer all questions/);
    vm.uiState.showRegister = false;
});
await test('62 complete registrations stored with all intermediate scores', async () => {
    for (let i = 1; i <= 62; i++) await register(i);
    await tick(20);
    const docs = playersDocs().filter(p => p.assessment);
    assert.equal(docs.length, 62);
    const d = docs[0];
    for (const k of ['questionnaireAverage', 'questionnaireScore', 'selfAssessmentScore', 'finalSkillScore', 'heightScore', 'experienceScore', 'wpr']) assert.equal(typeof d.ratings[k], 'number', k);
    const exp = E.computeRatings(d, E.DEFAULT_HEIGHT_TABLE);
    assert.equal(d.ratings.wpr, exp.wpr);
    assert.ok(['pending', 'flagged'].includes(d.validation.status));
});
await test('idempotent submit: re-submitting the same form does not duplicate', async () => {
    const before = playersDocs().length; await vm.submitRegistration(); await tick(); assert.equal(playersDocs().length, before);
});
await test('player can edit own registration after submitting; other players are not editable', async () => {
    const mine = vm.myPlayers.find(p => p.name === 'Player 01');
    assert.ok(mine, 'registrant should own their registration on this device');
    assert.ok(!vm.canEditPlayer(vm.players.find(p => p.id === 'p_legacy')));
    vm.openEditRegistration(mine); assert.equal(vm.regMode, 'edit'); assert.equal(vm.regDraft.name, 'Player 01');
    vm.regDraft.instrument = 'Trombone'; vm.goRegStep(6); assert.equal(vm.regStep, 6, vm.regError);
    await vm.submitRegistration(); await tick();
    const d = playersDocs().find(p => p.id === mine.id);
    assert.equal(d.instrument, 'Trombone'); assert.equal(d.name, 'Player 01');
    assert.ok(logs().some(l => l.action === 'player_edited_by_player' && l.target === mine.id));
    vm.activeTab = 'directory'; await tick(); vm.uiState.showMore = true; await tick(); vm.uiState.showMore = false;
});
await test('nobody is draft-eligible before admin approval', async () => { assert.equal(vm.rankedRows.length, 0); });

console.log('\nAdmin validation');
await login('admin123', 'Coach Admin');
await test('admin login sets role and operator name', async () => { assert.equal(vm.role, 'admin'); assert.equal(vm.operatorName, 'Coach Admin'); });
await test('approve 59 players without changing scores → eligible & tiers 15/15/15/14', async () => {
    const regs = vm.players.filter(p => p.assessment).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 59);
    for (const p of regs) { vm.approveAssessment(p); await confirmYes(); }
    await tick(10);
    assert.equal(vm.rankedRows.length, 59);
    assert.deepEqual([1, 2, 3, 4].map(t => vm.rankedRows.filter(r => r.tier === t).length), [15, 15, 15, 14]);
    assert.ok(logs().filter(l => l.action === 'assessment_approved').length >= 59);
});
await test('flag requires a reason and keeps player out of the pool', async () => {
    const p = vm.players.find(x => x.name === 'Player 60');
    vm.flagAssessment(p); vm.confirmState.reason = ''; await vm.runConfirm(); assert.ok(vm.confirmState.open, 'should stay open without reason');
    await confirmYes('Self-rating looks inconsistent');
    await tick(); assert.equal(vm.players.find(x => x.id === p.id).validation.status, 'flagged');
    assert.equal(vm.rankMap[p.id], undefined);
});
let adjustedId;
await test('adjustment keeps original answers, stores audit history, recalculates WPR & tier', async () => {
    const row = vm.rankedRows[vm.rankedRows.length - 1]; const p = row.player; adjustedId = p.id;
    const origA = JSON.stringify(p.assessment), before = row.ratings.wpr;
    vm.openAdjust(p); E.ALL_KEYS.forEach(k => vm.adjustForm.values[k] = 5); vm.adjustForm.reason = 'Verified at tryout';
    await vm.saveAdjust(); await tick(10);
    const np = vm.players.find(x => x.id === p.id);
    assert.equal(JSON.stringify(np.assessment), origA);
    assert.equal(np.validation.status, 'adjusted');
    assert.equal(np.adjustmentHistory.length, 1); assert.equal(np.adjustmentHistory[0].byName, 'Coach Admin');
    assert.ok(vm.rankMap[p.id].ratings.wpr > before); assert.ok(vm.rankMap[p.id].tier < row.tier);
    assert.ok(logs().some(l => l.action === 'skill_adjusted' && l.reason === 'Verified at tryout'));
});
await test('legacy player: admin enters assessment + measured height, then approves', async () => {
    const p = vm.players.find(x => x.id === 'p_legacy');
    assert.ok(E.playerFlags(p).includes('incomplete_assessment'));
    vm.openAdjust(p); assert.equal(vm.adjustForm.mode, 'enter'); E.ALL_KEYS.forEach(k => vm.adjustForm.values[k] = 3); vm.adjustForm.reason = 'Interviewed';
    await vm.saveAdjust(); await tick();
    vm.measuredForm.ft = 6; vm.measuredForm.inch = 1; await vm.saveMeasuredHeight(vm.players.find(x => x.id === 'p_legacy')); await tick();
    const lp = vm.players.find(x => x.id === 'p_legacy'); assert.equal(lp.measuredHeightIn, 73); assert.equal(lp.name, 'Legacy Larry'); assert.equal(lp.instrument, 'Tuba');
    vm.approveAssessment(lp); await confirmYes(); await tick();
    assert.equal(vm.rankedRows.length, 60);
});
await test('manual tier override is logged and keeps calculated tier', async () => {
    const row = vm.rankedRows.find(r => r.tier === 4); vm.openOverride(row.player); vm.overrideForm.tier = '3'; vm.overrideForm.reason = 'Coach assessment';
    await vm.saveOverride(row); await tick();
    const r2 = vm.rankMap[row.player.id]; assert.equal(r2.tier, 3); assert.equal(r2.calculatedTier, 4);
    assert.ok(logs().some(l => l.action === 'tier_override'));
    // undo it to keep 15/15/15/15
    vm.openOverride(r2.player); vm.overrideForm.reason = 'Revert'; await vm.saveOverride(r2, true); await tick();
    assert.equal(vm.rankMap[row.player.id].tier, 4);
});
await test('height table edit recalculates ratings and is logged', async () => {
    vm.startEditHeightTable(); vm.heightTableDraft[vm.heightTableDraft.length - 1].score = 95; vm.saveHeightTable(); await confirmYes('Rebalance'); await tick(20);
    assert.equal(vm.heightTable[vm.heightTable.length - 1].score, 95);
    assert.ok(logs().some(l => l.action === 'height_table_updated')); assert.ok(logs().some(l => l.action === 'wpr_recalculated'));
});

console.log('\nTier finalization & draft');
await test('finalize tiers → locked pool of 60 (15 per tier)', async () => {
    vm.finalizeTiers(); await confirmYes(); await tick(10);
    assert.equal(vm.draftStatus, 'ready'); assert.equal(Object.keys(vm.draftState.pool).length, 60);
    assert.deepEqual(JSON.parse(JSON.stringify(vm.draftState.remaining)), { 1: 15, 2: 15, 3: 15, 4: 15 });
});
await test('overrides are blocked once tiers are locked', async () => {
    const row = vm.rankedRows[0]; vm.overrideForm.playerId = row.player.id; vm.overrideForm.tier = '2'; vm.overrideForm.reason = 'x';
    await vm.saveOverride(row); await tick(); assert.equal(vm.draftState.pool[row.player.id].tier, 1);
});
await test('start draft (admin)', async () => { vm.startDraft(); await confirmYes(); await tick(); assert.equal(vm.draftStatus, 'active'); });

const pickAs = async (role, pid) => { vm.role = role; const p = vm.draftPoolPlayers.find(x => x.id === pid) || { id: pid, name: pid, poolEntry: vm.draftState.pool[pid] }; vm.initiatePick(p); if (!vm.confirmState.open) return 'blocked'; await vm.runConfirm(); await tick(); return vm.confirmState.open ? 'error' : 'ok'; };
const firstOfTier = t => vm.draftPoolPlayers.find(p => p.poolEntry.tier === t).id;

await test('wrong captain and spectator cannot pick; correct captain can', async () => {
    assert.equal(vm.currentDraftTeam, 'maroon');
    assert.equal(await pickAs('captain-gold', firstOfTier(1)), 'blocked');
    assert.equal(await pickAs('spectator', firstOfTier(1)), 'blocked');
    assert.equal(await pickAs('captain-maroon', firstOfTier(1)), 'ok');
    assert.equal(vm.draftState.currentPick, 2); assert.equal(vm.currentDraftTeam, 'gold');
});
await test('tier enforcement: Tier 2 player rejected during Tier 1 phase (client + transaction)', async () => {
    assert.equal(await pickAs('captain-gold', firstOfTier(2)), 'blocked');
    vm.role = 'captain-gold'; await assert.rejects(vm.submitPick(firstOfTier(2), vm.draftState.currentPick), /Only Tier 1/);
});
await test('simultaneous picks from two devices: exactly one succeeds', async () => {
    vm.role = 'captain-gold'; const pick = vm.draftState.currentPick;
    const ids = vm.draftPoolPlayers.filter(p => p.poolEntry.tier === 1).slice(0, 2).map(p => p.id);
    const retriesBefore = fb.stats.txRetries; fb.barrier = { suffix: '/system/draft', n: 2, waiting: [] }; // both devices read the same pre-pick state
    const results = await Promise.allSettled([vm.submitPick(ids[0], pick), vm.submitPick(ids[1], pick)]); await tick();
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(results.find(r => r.status === 'rejected').reason.message, /another device|already/);
    assert.equal(vm.players.filter(p => p.team === 'gold').length, 1);
    assert.ok(fb.stats.txRetries > retriesBefore, 'stale concurrent transaction must be retried, then rejected');
});
await test('duplicate pick of an already drafted player is rejected by the transaction', async () => {
    const drafted = vm.players.find(p => p.team === 'maroon').id; vm.role = 'captain-black';
    await assert.rejects(vm.submitPick(drafted, vm.draftState.currentPick), /not in the draft pool|already been drafted/);
});
await test('pause blocks picks on all clients; resume keeps exact position', async () => {
    vm.role = 'admin'; await vm.pauseDraft(); await tick(); assert.equal(vm.draftStatus, 'paused');
    const pos = vm.draftState.currentPick, team = vm.currentDraftTeam;
    vm.role = 'captain-' + team; await assert.rejects(vm.submitPick(firstOfTier(1), pos), /paused/);
    vm.role = 'admin'; await vm.resumeDraft(); await tick(); assert.equal(vm.draftState.currentPick, pos); assert.equal(vm.currentDraftTeam, team);
});
await test('undo last pick: player back in pool, turn restored, history kept', async () => {
    vm.role = 'captain-black'; assert.equal(await pickAs('captain-black', firstOfTier(1)), 'ok');
    const last = vm.lastActivePick; assert.equal(last.team, 'black');
    vm.role = 'admin'; vm.undoLastPick(); await confirmYes('Wrong player tapped'); await tick();
    assert.equal(vm.currentDraftTeam, 'black'); assert.equal(vm.players.find(p => p.id === last.playerId).team, null);
    const hist = vm.sessionPicks; assert.ok(hist.some(e => e.id === last.id && e.status === 'undone')); assert.ok(hist.some(e => e.type === 'undo' && e.undoesPickId === last.id));
    assert.ok(logs().some(l => l.action === 'draft_undo' && l.reason === 'Wrong player tapped'));
});
await test('trades/removals blocked during draft', async () => {
    const [a, b] = vm.players; vm.tradeState.player1 = a.id; vm.tradeState.player2 = b.id; const teamA = a.team;
    await vm.executeTrade(); await tick(); assert.equal(vm.players.find(p => p.id === a.id).team, teamA);
});
await test('full draft completes: 15 per team, tier phases in order, no duplicates', async () => {
    let guard = 0;
    while (vm.draftStatus === 'active' && guard++ < 100) {
        const t = vm.activeDraftTier; vm.role = 'captain-' + vm.currentDraftTeam;
        await vm.submitPick(firstOfTier(t), vm.draftState.currentPick); await tick();
    }
    assert.equal(vm.draftStatus, 'completed');
    for (const t of E.TEAMS) assert.equal(vm.players.filter(p => p.team === t).length, 15, t);
    const active = vm.sessionPicks.filter(e => e.type === 'pick' && e.status === 'active');
    assert.equal(active.length, 60); assert.equal(new Set(active.map(e => e.playerId)).size, 60);
    for (let i = 1; i < active.length; i++) assert.ok(active[i].tier >= active[i - 1].tier, 'tier phases must not go backwards');
    for (const t of E.TEAMS) assert.equal(vm.teamStats[t].count, 15);
    assert.match(String(vm.teamStats.maroon.avgWpr), /^\d+\.\d\d$/);
});
await test('no picks after finalization', async () => {
    vm.role = 'admin'; const leftover = vm.players.find(p => !p.team);
    if (leftover) await assert.rejects(vm.submitPick(leftover.id, vm.draftState.currentPick), /finalized|not in the draft pool/);
});
await test('audit log covers the pipeline', async () => {
    const actions = new Set(logs().map(l => l.action));
    for (const a of ['assessment_approved', 'assessment_flagged', 'skill_adjusted', 'assessment_entered', 'height_measured', 'tier_override', 'height_table_updated', 'wpr_recalculated', 'tiers_finalized', 'draft_started', 'draft_pick', 'draft_paused', 'draft_resumed', 'draft_undo'])
        assert.ok(actions.has(a), 'missing log: ' + a);
    assert.ok(logs().every(l => 'byUid' in l && 'clientAt' in l && 'action' in l && 'target' in l));
});
await test('DOM renders the draft room and admin dashboard without errors', async () => {
    vm.activeTab = 'draft'; await tick(); assert.ok(w.document.body.textContent.includes('Draft complete'));
    vm.draftView = 'history'; await tick(); assert.ok(w.document.body.textContent.includes('undone'));
    vm.activeTab = 'admin'; vm.adminSection = 'assess'; await tick(); assert.ok(w.document.body.textContent.includes('Draft-eligible'));
    vm.adminSection = 'tiers'; await tick(); vm.adminSection = 'logs'; await tick(); vm.adminSection = 'heights'; await tick();
    vm.activeTab = 'tiers'; await tick(); assert.ok(w.document.body.textContent.includes('Finalized draft pools'));
    vm.activeTab = 'awards'; await tick(); vm.activeTab = 'games'; await tick(); vm.activeTab = 'stats'; await tick(); vm.activeTab = 'rules'; await tick(); vm.activeTab = 'directory'; await tick();
    vm.openRegistration(); for (const s of [1, 2, 3, 4, 5, 6]) { vm.regStep = s; await tick(); } vm.uiState.showRegister = false;
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
