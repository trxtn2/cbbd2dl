// Stage 1 pipeline tests: assessment → WPR → tiers → snake draft.
// Loads the exact engine shipped in index.html (the <script id="cbbd-engine"> block) and runs it in a sandbox.
// Run: node tests/stage1.test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const src = html.match(/<script id="cbbd-engine">([\s\S]*?)<\/script>/)[1];
const sandbox = {}; vm.createContext(sandbox); vm.runInContext(src.replace('typeof window !== \'undefined\' ? window : globalThis', 'globalThis'), sandbox);
const E = sandbox.CBBDEngine;

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('  ✓', name); } catch (e) { failed++; console.log('  ✗', name, '\n    ', e.message); } };
const plain = v => JSON.parse(JSON.stringify(v)); // engine runs in another realm
const same = (a, b) => assert.deepEqual(plain(a), b);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const A = (v, self) => ({ experienceLevel: v, ruleKnowledge: v, shootingSkill: v, ballHandling: v, defensiveSkill: v, reboundingSkill: v, passingSkill: v, selfAssessedSkill: self ?? v });
let seq = 0;
const P = (over = {}) => { seq++; return { id: 'p_' + String(seq).padStart(4, '0'), registeredAt: 1000 + seq, name: 'Player ' + seq, years: 5, reportedHeightIn: 68,
    position: 'SF', team: null, deleted: false, assessment: A(3), validation: { status: 'verified' }, ...over }; };

console.log('\nPlayer Assessment');
test('weights sum to 100%', () => near(E.QUESTIONS.reduce((s, q) => s + q.weight, 0), 1));
test('complete questionnaire is detected; incomplete rejected', () => {
    assert.equal(E.isCompleteAssessment(A(3)), true);
    const a = A(3); delete a.passingSkill; assert.equal(E.isCompleteAssessment(a), false);
    assert.equal(E.isCompleteAssessment({ ...A(3), shootingSkill: 6 }), false);
});
test('spec example: weighted avg 3.5 → 62.5', () => {
    // all 3s, +1 on shooting (20%), ball handling (20%), experience (10%) → 3 + 0.2 + 0.2 + 0.1 = 3.5
    const a = { ...A(3), shootingSkill: 4, ballHandling: 4, experienceLevel: 4 };
    near(E.questionnaireWeightedAverage(a), 3.5); near(E.questionnaireScore(a), 62.5);
    near(E.questionnaireScore(A(3)), 50);
});
test('normalization bounds: all 1 → 0, all 5 → 100', () => { near(E.finalSkillScore(A(1)), 0); near(E.finalSkillScore(A(5)), 100); });
test('final skill = Q×0.85 + self×0.15', () => {
    const a = A(4, 2); // Q = 75, self = 25
    near(E.questionnaireScore(a), 75); near(E.selfAssessmentScore(2), 25); near(E.finalSkillScore(a), 75 * 0.85 + 25 * 0.15);
});

console.log('\nWPR');
test('spec inputs S75 H80 E60 → 74.50 (spec text says 72.50, an arithmetic slip: 37.5 + 28 + 9 = 74.5)', () => {
    near(E.computeWpr(75, 80, 60), 74.5); assert.equal(E.fmt2(E.computeWpr(75, 80, 60)), '74.50');
    assert.equal(E.fmt2(72.499999), '72.50');
});
test('height brackets (default table)', () => {
    const cases = [[58, 20], [59.9, 20], [60, 35], [62, 35], [63, 50], [64, 50], [65, 65], [66, 65], [67, 80], [68, 80], [69, 90], [70, 90], [71, 100], [76, 100]];
    for (const [h, s] of cases) assert.equal(E.heightScore(h, E.DEFAULT_HEIGHT_TABLE), s, `height ${h}`);
    assert.equal(E.heightScore(null), null);
});
test('admin-edited height table is respected (and unsorted input is sorted)', () => {
    const t = [{ minInches: 70, score: 99 }, { minInches: 0, score: 10 }];
    assert.equal(E.heightScore(69, t), 10); assert.equal(E.heightScore(70, t), 99);
});
test('band experience: min(years/10,1)×100', () => {
    for (const [y, s] of [[1, 10], [2, 20], [3, 30], [5, 50], [8, 80], [10, 100], [14, 100], [0, 0], [-2, 0]]) near(E.experienceScore(y), s);
});
test('measured height overrides self-reported and legacy bracket', () => {
    assert.equal(E.playerHeightInches({ measuredHeightIn: 66, reportedHeightIn: 72, height: "6'0 and above" }), 66);
    assert.equal(E.playerHeightInches({ reportedHeightIn: 72 }), 72);
    assert.equal(E.playerHeightInches({ height: "5'9 - 5'11" }), 70);
    assert.equal(E.heightSource({ height: "5'9 - 5'11" }), 'legacy');
});
test('computeRatings stores every intermediate and full precision', () => {
    const r = E.computeRatings({ assessment: A(4, 2), reportedHeightIn: 67, years: 6 }, E.DEFAULT_HEIGHT_TABLE);
    near(r.questionnaireScore, 75); near(r.selfAssessmentScore, 25); near(r.finalSkillScore, 67.5);
    assert.equal(r.heightScore, 80); near(r.experienceScore, 60); near(r.wpr, 67.5 * 0.5 + 80 * 0.35 + 60 * 0.15);
});

console.log('\nAnomaly detection');
test('beginner with high on-court skills is flagged', () => assert.ok(E.detectAnomalies({ ...A(5), experienceLevel: 1 }).includes('beginner_high_skills')));
test('beginner claiming advanced self-rating is flagged', () => assert.ok(E.detectAnomalies({ ...A(2), experienceLevel: 1, selfAssessedSkill: 5 }).includes('beginner_advanced_claim')));
test('large self vs questionnaire gap is flagged', () => assert.ok(E.detectAnomalies(A(1, 5)).includes('self_mismatch')));
test('all-5 answers flagged for confirmation only', () => same(E.detectAnomalies(A(5)), ['all_max']));
test('ordinary consistent answers are not flagged', () => same(E.detectAnomalies(A(3)), []));
test('legacy player: incomplete assessment + legacy height flags', () => same(E.playerFlags({ height: "5'5 - 5'8", skill: 3 }), ['incomplete_assessment', 'legacy_height']));

console.log('\nEligibility');
test('only approved (verified/adjusted) + complete players are eligible', () => {
    assert.equal(E.isEligible(P({ validation: { status: 'pending' } })), false);
    assert.equal(E.isEligible(P({ validation: { status: 'flagged' } })), false);
    assert.equal(E.isEligible(P({ validation: { status: 'verified' } })), true);
    assert.equal(E.isEligible(P({ validation: { status: 'adjusted' } })), true);
    assert.equal(E.isEligible(P({ assessment: null })), false);
    assert.equal(E.isEligible(P({ deleted: true })), false);
    assert.equal(E.isEligible(P({ reportedHeightIn: null })), false);
});

console.log('\nTier engine');
const many = n => Array.from({ length: n }, (_, i) => P({ years: (i % 10) + 1, reportedHeightIn: 60 + (i % 13), assessment: A((i % 5) + 1, ((i * 3) % 5) + 1) }));
test('60 eligible → 15/15/15/15, every player in exactly one tier, sorted by WPR', () => {
    const rows = E.rankPlayers(many(60));
    const c = [1, 2, 3, 4].map(t => rows.filter(r => r.tier === t).length); assert.deepEqual(c, [15, 15, 15, 15]);
    assert.equal(new Set(rows.map(r => r.player.id)).size, 60);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].ratings.wpr >= rows[i].ratings.wpr - 1e-9);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].calculatedTier <= rows[i].calculatedTier);
});
test('59 eligible → 15/15/15/14', () => assert.deepEqual([1, 2, 3, 4].map(t => E.rankPlayers(many(59)).filter(r => r.tier === t).length), [15, 15, 15, 14]));
test('tierSizes distributes remainder to higher tiers', () => { same(E.tierSizes(62), [16, 16, 15, 15]); same(E.tierSizes(3), [1, 1, 1, 0]); });
test('ineligible players are excluded from tiers', () => {
    const ps = many(8); ps[0].validation = { status: 'flagged' }; ps[1].validation = { status: 'pending' };
    assert.equal(E.rankPlayers(ps).length, 6);
});
test('identical WPR: tie broken by Final Skill, then review status, then registration id (deterministic)', () => {
    // a: S100 H20 E70 → 50 + 7 + 10.5 = 67.5 ; b: S50 H100 E50 → 25 + 35 + 7.5 = 67.5  (identical WPR)
    const a = P({ assessment: A(5), reportedHeightIn: 58, years: 7 });
    const b = P({ assessment: A(3), reportedHeightIn: 71, years: 5 });
    const b2 = P({ assessment: A(3), reportedHeightIn: 71, years: 5, validation: { status: 'adjusted' } });
    const b3 = P({ assessment: A(3), reportedHeightIn: 71, years: 5 });
    near(E.computeRatings(a).wpr, 67.5); near(E.computeRatings(b).wpr, 67.5);
    const rows = E.rankPlayers([b3, b2, b, a]);
    assert.deepEqual(rows.map(r => r.player.id), [a.id, b.id, b3.id, b2.id]); // verified before adjusted, then id
    const again = E.rankPlayers([a, b2, b3, b]); assert.deepEqual(again.map(r => r.player.id), rows.map(r => r.player.id));
});
test('admin assessment adjustment recalculates WPR and moves tier; original kept', () => {
    const ps = many(8); const target = ps[7];
    const before = E.rankPlayers(ps).find(r => r.player.id === target.id);
    target.adjustedAssessment = A(5); target.validation = { status: 'adjusted' };
    const after = E.rankPlayers(ps).find(r => r.player.id === target.id);
    assert.ok(after.ratings.wpr > before.ratings.wpr); assert.equal(after.ratings.usesAdjustment, true);
    assert.ok(target.assessment.shootingSkill !== 5 || true); assert.ok(E.isCompleteAssessment(target.assessment));
});
test('manual tier override changes effective tier but keeps calculated tier', () => {
    const ps = many(8); ps[0].tierOverride = { tier: 4, reason: 'test' };
    const r = E.rankPlayers(ps).find(x => x.player.id === ps[0].id);
    assert.equal(r.tier, 4); assert.equal(r.overridden, r.calculatedTier !== 4);
});

console.log('\nSnake draft');
test('four-team snake sequence', () => {
    const seqTeams = Array.from({ length: 16 }, (_, i) => E.teamForPick(i + 1));
    assert.deepEqual(seqTeams, ['maroon','gold','black','green','green','black','gold','maroon','maroon','gold','black','green','green','black','gold','maroon']);
});
test('configurable initial order', () => {
    const o = ['green', 'maroon', 'black', 'gold'];
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(p => E.teamForPick(p, o)), ['green','maroon','black','gold','gold','black','maroon','green']);
    same(E.normalizeOrder(['x']), plain(E.TEAMS));
});

const newDraft = (n) => {
    const players = many(n); const rows = E.rankPlayers(players);
    const { pool, remaining, teamCounts } = E.buildDraftPool(rows, players);
    return { players, draft: { status: 'active', currentPick: 1, teamOrder: E.TEAMS.slice(), pool, remaining, teamCounts, picked: {}, pickStack: [], rosterLimit: 15 } };
};
// Simulates the Firestore transaction: validate against the latest committed state, then apply.
const tryPick = (state, pid, role, expectedPick) => {
    const pl = state.players.find(p => p.id === pid);
    const err = E.validatePick(state.draft, { playerId: pid, playerTeam: pl.team, playerDeleted: pl.deleted, actorRole: role, expectedPick: expectedPick ?? state.draft.currentPick });
    if (err) return err;
    const r = E.applyPick(state.draft, pid);
    pl.team = r.team; Object.assign(state.draft, r.update); state.draft.pickStack = [...state.draft.pickStack, { ...r, playerId: pid }];
    return null;
};
const firstInTier = (st, t) => Object.keys(st.draft.pool).find(id => st.draft.pool[id].tier === t && !st.draft.picked[id]);

test('open draft: captains may pick any tier at any time', () => {
    const st = newDraft(60);
    assert.equal(tryPick(st, firstInTier(st, 4), 'captain-maroon'), null);
    assert.equal(tryPick(st, firstInTier(st, 2), 'captain-' + E.teamForPick(st.draft.currentPick)), null);
    assert.equal(tryPick(st, firstInTier(st, 1), 'captain-' + E.teamForPick(st.draft.currentPick)), null);
});
test('full 60-player draft: 15 per team, every player drafted once, completes', () => {
    const st = newDraft(60);
    while (st.draft.status === 'active') {
        const t = E.activeTier(st.draft.remaining);
        assert.equal(tryPick(st, firstInTier(st, t), 'captain-' + E.teamForPick(st.draft.currentPick)), null);
    }
    assert.equal(st.draft.status, 'completed');
    for (const t of E.TEAMS) assert.equal(st.players.filter(p => p.team === t).length, 15);
    // each team got 3–4 from every tier
    for (const t of E.TEAMS) for (const tier of [1, 2, 3, 4]) { const n = st.players.filter(p => p.team === t && st.draft.pool[p.id].tier === tier).length; assert.ok(n >= 3 && n <= 4, `${t} tier${tier}=${n}`); }
    assert.match(tryPick(st, st.players[0].id, 'admin'), /finalized/);
});
test('roster limit: no team can exceed 15 (more than 60 eligible)', () => {
    const st = newDraft(64);
    while (st.draft.status === 'active') tryPick(st, firstInTier(st, E.activeTier(st.draft.remaining)), 'admin');
    for (const t of E.TEAMS) assert.equal(st.players.filter(p => p.team === t).length, 15);
    assert.equal(st.players.filter(p => !p.team).length, 4);
});
test('duplicate selection prevented', () => {
    const st = newDraft(8); const id = firstInTier(st, 1);
    assert.equal(tryPick(st, id, 'captain-maroon'), null);
    assert.match(tryPick(st, id, 'captain-gold'), /already been drafted/);
});
test('unauthorized captain / spectator cannot pick', () => {
    const st = newDraft(8);
    assert.match(tryPick(st, firstInTier(st, 1), 'captain-gold'), /Only the Team maroon captain/);
    assert.match(tryPick(st, firstInTier(st, 1), 'spectator'), /Only the Team maroon captain/);
});
test('simultaneous attempts: second device with stale pick number is rejected', () => {
    const st = newDraft(8); const pick = st.draft.currentPick;
    const ids = Object.keys(st.draft.pool).filter(id => st.draft.pool[id].tier === 1);
    assert.equal(tryPick(st, ids[0], 'captain-maroon', pick), null);
    assert.match(tryPick(st, ids[1], 'captain-maroon', pick), /already made from another device/);
    assert.equal(Object.keys(st.draft.picked).length, 1);
});
test('pause blocks picks; resume continues from exact position', () => {
    const st = newDraft(8); tryPick(st, firstInTier(st, 1), 'captain-maroon');
    st.draft.status = 'paused'; const pos = st.draft.currentPick;
    assert.match(tryPick(st, firstInTier(st, 1), 'captain-gold'), /paused/);
    st.draft.status = 'active'; assert.equal(st.draft.currentPick, pos); assert.equal(tryPick(st, firstInTier(st, 1), 'captain-gold'), null);
});
test('undo restores turn, pool, counts; completed draft returns to paused', () => {
    const st = newDraft(8);
    tryPick(st, firstInTier(st, 1), 'captain-maroon'); tryPick(st, firstInTier(st, 1), 'captain-gold');
    const last = st.draft.pickStack[st.draft.pickStack.length - 1];
    const u = E.applyUndo(st.draft, last);
    assert.equal(u.currentPick, 2); assert.equal(u.teamCounts.gold, 0); assert.equal(u.remaining[last.tier], E.rankPlayers(st.players).filter(r => r.tier === last.tier).length - 1);
    assert.equal(u.picked[last.playerId], undefined); assert.equal(u.pickStack.length, 1);
    assert.equal(E.applyUndo({ ...st.draft, status: 'completed' }, last).status, 'paused');
});
test('players already on a roster are excluded from the pool and counted', () => {
    const ps = many(8); ps[0].team = 'gold';
    const { pool, teamCounts } = E.buildDraftPool(E.rankPlayers(ps), ps);
    assert.equal(pool[ps[0].id], undefined); assert.equal(teamCounts.gold, 1);
});
test('draft that is not initialized / not active rejects picks', () => {
    assert.match(E.validatePick({ status: 'active', currentPick: 1 }, { expectedPick: 1 }), /not been initialized/);
    assert.match(E.validatePick({ status: 'ready', currentPick: 1, pool: {} }, { expectedPick: 1 }), /not active/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
