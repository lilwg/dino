// perfect-teacher.js — Exhaustive simStep-based expectimax "teacher" for
// the ML enemy-avoidance project.
//
// Design:
//   1. Uses the real game engine (simStep) as ground truth — zero modeling error.
//   2. At each (state, player_dir) node: branches over every simHopDecision()
//      bit and every simRng() call the engine consumed during that hop.
//      Exhaustive enumeration when total bits <= THRESHOLD, Monte Carlo otherwise.
//   3. Memoized on canonical state key. Offline-only; no runtime budget.
//   4. P(survive N) = max over player_dir of [ avg over enemy RNG of
//                     (1 if died else P(survive N-1)) ]
//
// Exports (via globals, since we eval() into node):
//   perfectTeacherEval(gs, depth, opts) -> { dir: P(survive depth hops) }
//   perfectTeacherSurvive(gs, depth, opts) -> scalar max-over-dirs P
//   perfectTeacherStats() -> diagnostics object
//   perfectTeacherReset() -> clears memo + stats
//
// opts: {
//   exhaustiveBitsLimit: int,   // default 20 — exhaustive if total bits <= this
//   mcSamples: int,             // default 1024 — samples when falling back to MC
//   maxMemoEntries: int,        // default 2_000_000
//   seed: int,                  // default 0xC0FFEE
// }
//
// Requires qbert.js + qbert-ai.js already eval'd (needs DIRS, DIR_KEYS_WITH_STAY,
// isValidPos, simDeepClone, simStep, simHopDecisionQ/Idx, simRng, POS_COUNT, etc).

// ─── Globals ────────────────────────────────────────────────────────────────
var teacherMemo = new Map();
var teacherStats = {
    evals: 0, memoHits: 0, memoStores: 0,
    exhaustiveNodes: 0, mcNodes: 0,
    simStepCalls: 0, deathsObserved: 0,
    maxDepthSeen: 0,
};
var TEACHER_DEFAULTS = {
    exhaustiveBitsLimit: 20,
    mcSamples: 1024,
    worstCaseK: 16,            // # RNG streams sampled per dir; min(P_stream) is used
    maxMemoEntries: 2_000_000,
    seed: 0xC0FFEE,
    deadlineMs: Infinity,
};
var _teacherBudgetExceeded = false;

function perfectTeacherReset() {
    teacherMemo = new Map();
    teacherStats = {
        evals: 0, memoHits: 0, memoStores: 0,
        exhaustiveNodes: 0, mcNodes: 0,
        simStepCalls: 0, deathsObserved: 0,
        maxDepthSeen: 0, budgetExceeded: false,
    };
    _teacherBudgetExceeded = false;
}

function perfectTeacherStats() {
    return Object.assign({ memoSize: teacherMemo.size }, teacherStats);
}

// ─── Canonical state key ────────────────────────────────────────────────────
// Collapses floating-point jumpT to frame integers so memo hits are reliable.
function teacherStateKey(gs) {
    var p = gs.player;
    var pJumpFrame = p.jumping ? Math.round((p.jumpT || 0) * (p.jumpDur || 1) * 1000) : 0;
    var k = p.row + ',' + p.col + ',' + (p.jumping ? 1 : 0) + ',' + pJumpFrame + ',' +
            (p.destRow == null ? -1 : p.destRow) + ',' +
            (p.destCol == null ? -1 : p.destCol) + ',' +
            (p.prevRow == null ? -1 : p.prevRow) + ',' +
            (p.prevCol == null ? -1 : p.prevCol) + ',' +
            (gs.freezeTimer || 0);
    // Enemies — sort canonically so order doesn't matter.
    var es = [];
    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type === 'spawn-timer') {
            es.push('T:' + e.timer + ':' + (e.forcedType || ''));
            continue;
        }
        var ejf = e.jumping ? Math.round((e.jumpT || 0) * (e.jumpDur || 1) * 1000) : 0;
        es.push(
            e.type + ':' + e.row + ',' + e.col + ',' +
            (e.jumping ? 1 : 0) + ',' + ejf + ',' +
            (e.destRow == null ? -1 : e.destRow) + ',' +
            (e.destCol == null ? -1 : e.destCol) + ',' +
            (e.moveTimer || 0) + ',' + (e.moveInterval || 0) + ',' +
            (e.hops || 0) + ',' +
            (e.dirBits == null ? -1 : e.dirBits) + ',' +
            (e.falling ? 1 : 0) + ',' + (e.willHatch ? 1 : 0) + ',' +
            (e.spawnAnimTimer || 0) + ',' +
            (e.lureRow == null ? -1 : e.lureRow) + ',' +
            (e.lureCol == null ? -1 : e.lureCol)
        );
    }
    es.sort();
    return k + '|' + es.join(';');
}

// ─── Stochasticity measurement ──────────────────────────────────────────────
// Runs simStep once to count how many simHopDecision bits + simRng calls
// the engine consumes for a given (gs, dir). This tells us the branching
// factor of this node.
function teacherMeasureBranching(gs, dir) {
    var gs1 = simDeepClone(gs);
    gs1.survivalOnly = true;
    var savedQ = simHopDecisionQ;
    var savedIdx = simHopDecisionIdx;
    var savedRng = simRng;
    // All-zero hop decisions, deterministic simRng. We only want COUNTS.
    simHopDecisionQ = new Array(256).fill(0);
    simHopDecisionIdx = 0;
    var rngCount = 0;
    simRng = function() { rngCount++; return 0.5; };
    simStep(gs1, dir);
    var hopBits = simHopDecisionIdx;
    simHopDecisionQ = savedQ;
    simHopDecisionIdx = savedIdx;
    simRng = savedRng;
    return { hopBits: hopBits, rngCalls: rngCount };
}

// ─── Seeded RNG (xorshift32) ────────────────────────────────────────────────
function mkXorshift(seed) {
    var s = (seed | 0) || 1;
    return function() {
        s ^= s << 13; s |= 0;
        s ^= s >>> 17;
        s ^= s << 5; s |= 0;
        // Convert to [0,1)
        return ((s >>> 0) % 0x100000000) / 0x100000000;
    };
}

// ─── Execute one hop with a fixed RNG sequence ──────────────────────────────
// Returns { alive, gs } after running simStep(gs, dir) with the given
// hop-decision bit array and simRng replacement.
function teacherExecHop(gs, dir, hopBitArr, rngFn) {
    var savedQ = simHopDecisionQ;
    var savedIdx = simHopDecisionIdx;
    var savedRng = simRng;
    var gs1 = simDeepClone(gs);
    gs1.survivalOnly = true;
    simHopDecisionQ = hopBitArr;
    simHopDecisionIdx = 0;
    simRng = rngFn;
    var alive;
    if (dir === 'STAY') {
        // Game's STAY only advances 1 frame (AI re-polled each frame).
        // Don't use simStep's STAY which waits for coily's full jump cycle.
        simUpdateEnemies(gs1);
        simCheckCollision(gs1);
        alive = gs1.alive;
    } else {
        alive = simStep(gs1, dir);
    }
    simHopDecisionQ = savedQ;
    simHopDecisionIdx = savedIdx;
    simRng = savedRng;
    teacherStats.simStepCalls++;
    if (teacherStats.simStepCalls >= teacherStats._budget) {
        _teacherBudgetExceeded = true;
        teacherStats.budgetExceeded = true;
    }
    if (!alive) teacherStats.deathsObserved++;
    return { alive: alive, gs: gs1 };
}

// ─── Core recursion ─────────────────────────────────────────────────────────
// Returns P(survive `depth` hops) = max over player dirs.
function perfectTeacherSurvive(gs, depth, opts) {
    opts = opts || TEACHER_DEFAULTS;
    if (!gs.alive) return 0.0;
    if (depth <= 0) return 1.0;
    if (depth > teacherStats.maxDepthSeen) teacherStats.maxDepthSeen = depth;

    var memoKey = teacherStateKey(gs) + '|' + depth;
    if (teacherMemo.has(memoKey)) {
        teacherStats.memoHits++;
        return teacherMemo.get(memoKey);
    }
    teacherStats.evals++;

    var bestP = 0.0;
    // Only allow STAY at the root (caller uses DIR_KEYS_WITH_STAY for top-level).
    // In the recursive tree, exclude STAY because each STAY only advances 1 frame
    // in reality — stacking 8 STAYs would give a meaninglessly short horizon.
    var dirs = typeof DIR_KEYS !== 'undefined' ? DIR_KEYS
                : ['UL', 'UR', 'DL', 'DR'];
    for (var k = 0; k < dirs.length; k++) {
        var dir = dirs[k];
        var d = DIRS[dir];
        if (!isValidPos(gs.player.row + d.dr, gs.player.col + d.dc)) continue;
        var p = teacherBranchProb(gs, dir, depth, opts);
        if (p > bestP) bestP = p;
        if (bestP >= 1.0) break;
    }

    if (teacherMemo.size < opts.maxMemoEntries) {
        teacherMemo.set(memoKey, bestP);
        teacherStats.memoStores++;
    }
    return bestP;
}

// Per-direction MIN-over-hop-bit-enumeration adaptive survival.
// Exhaustively enumerates enemy hop-bit decisions (egg/ugg/wrongway DL/DR,
// up/stay choices consumed via simHopDecisionQ). For spawn events (simRng
// direct calls), tests BOTH simRng=0.0 (spawnCol=0, dirBits=0) and
// simRng=0.5 (spawnCol=1, dirBits=64) and takes MIN. This covers both
// possible spawn columns — the main source of spawn variance that matters.
//
// Returns MIN across all (hop-bit combo × spawn-rng) outcomes.
function teacherBranchProb(gs, dir, depth, opts) {
    var nextDepth = depth - 1;
    teacherStats.exhaustiveNodes++;
    var b = teacherMeasureBranching(gs, dir);
    var hopBits = b.hopBits;
    if (hopBits > opts.exhaustiveBitsLimit) hopBits = opts.exhaustiveBitsLimit;
    var combos = 1 << hopBits;
    // Enumerate both spawn-col outcomes if spawn events present.
    var rngVals = b.rngCalls > 0 ? [_teacherRng0, _teacherRng5] : [_teacherRng5];
    var minSurv = 1.0;
    for (var ri = 0; ri < rngVals.length; ri++) {
        for (var c = 0; c < combos; c++) {
            var bits = new Array(hopBits);
            for (var bi = 0; bi < hopBits; bi++) bits[bi] = (c >> bi) & 1;
            var res = teacherExecHop(gs, dir, bits, rngVals[ri]);
            var p = res.alive ? perfectTeacherSurvive(res.gs, nextDepth, opts) : 0.0;
            if (p < minSurv) minSurv = p;
            if (minSurv === 0.0) return 0.0; // early exit
        }
    }
    return minSurv;
}
function _teacherRng0() { return 0.0; }
function _teacherRng5() { return 0.5; }

// FNV-1a 32-bit string hash.
function hashString(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) | 0;
    }
    return h | 0;
}

// ─── Outer-sampled deterministic expectimax ─────────────────────────────────
// Architecture: instead of MC-branching at EVERY spawn event (which nests and
// explodes as K^numSpawns), we sample K full RNG streams ONCE at the root and
// run deterministic expectimax under each. Spawn events inside the subtree
// resolve deterministically from the outer stream.
//
// Trade-off (Jensen's inequality): E_rng[max_dir V] >= max_dir E_rng[V], so
// this slightly OVERestimates true P(survive). Since the real player observes
// enemy RNG realizations hop-by-hop and can adapt, this optimism is actually
// realistic for a top-level decision. The only true info asymmetry is for
// brand-new spawn dirBits that the player hasn't yet observed — 1-2 hops of
// optimism in practice.

// Mutable-state xorshift32 stream (for save/restore at CRN points).
function mkStreamCtx(seed) {
    var s = (seed | 0) || 1;
    return {
        next: function() {
            s ^= s << 13; s |= 0;
            s ^= s >>> 17;
            s ^= s << 5; s |= 0;
            return ((s >>> 0) % 0x100000000) / 0x100000000;
        },
        save: function() { return s | 0; },
        restore: function(v) { s = v | 0; }
    };
}

// Run simStep using a stream-backed simRng + simHopDecision.
// stream drives BOTH enemy hop-bit decisions AND spawn RNG.
function teacherExecHopDet(gs, dir, stream) {
    var savedQ = simHopDecisionQ;
    var savedIdx = simHopDecisionIdx;
    var savedRng = simRng;
    var gs1 = simDeepClone(gs);
    gs1.survivalOnly = true;
    simHopDecisionQ = null;   // disable queue; simHopDecision falls through to simRng
    simHopDecisionIdx = 0;
    simRng = stream.next;
    var alive = simStep(gs1, dir);
    simHopDecisionQ = savedQ;
    simHopDecisionIdx = savedIdx;
    simRng = savedRng;
    teacherStats.simStepCalls++;
    if (teacherStats.simStepCalls >= teacherStats._budget) {
        _teacherBudgetExceeded = true;
        teacherStats.budgetExceeded = true;
    }
    if (!alive) teacherStats.deathsObserved++;
    return { alive: alive, gs: gs1 };
}

// Deterministic expectimax under a FIXED stream. Max over player dirs.
// CRN is achieved by save/restoring stream state between dir attempts at the
// same node — all dirs see the same RNG prefix.
// Note: excludes STAY from the future max — otherwise the teacher's imagined
// "stay now, escape later" plan never materializes in real play (AI keeps
// getting STAY recommended and keeps staying, trapped).
function teacherDeterministicSurvive(gs, depth, stream, opts) {
    if (!gs.alive) return 0.0;
    if (depth <= 0) return 1.0;

    // Memo: key includes stream state so we only memo within one sample's tree.
    var memoKey = teacherStateKey(gs) + '|' + depth + '|s' + stream.save();
    if (teacherMemo.has(memoKey)) {
        teacherStats.memoHits++;
        return teacherMemo.get(memoKey);
    }
    teacherStats.evals++;

    var bestP = 0.0;
    // Moves only — STAY is deferred to the top-level (current-hop) decision.
    var dirs = typeof DIR_KEYS !== 'undefined' ? DIR_KEYS
                : ['UL', 'UR', 'DL', 'DR'];
    var streamStart = stream.save();
    for (var k = 0; k < dirs.length; k++) {
        var dir = dirs[k];
        if (dir !== 'STAY') {
            var d = DIRS[dir];
            if (!isValidPos(gs.player.row + d.dr, gs.player.col + d.dc)) continue;
        }
        // CRN: reset stream to node-start before each dir attempt
        stream.restore(streamStart);
        var res = teacherExecHopDet(gs, dir, stream);
        if (res.alive) {
            var p = teacherDeterministicSurvive(res.gs, depth - 1, stream, opts);
            if (p > bestP) bestP = p;
            if (bestP >= 1.0) break;
        }
    }
    // Restore for caller (in case we broke out early)
    stream.restore(streamStart);

    if (teacherMemo.size < opts.maxMemoEntries) {
        teacherMemo.set(memoKey, bestP);
        teacherStats.memoStores++;
    }
    return bestP;
}

// Is there a spawn event or ball-with-null-dirBits in the horizon?
// (These consume simRng directly and require outer sampling.)
function teacherSpawnInHorizon(gs, depth) {
    // Conservative upper bound on frames in horizon
    var pJumpDur = PLAYER_JUMP_DUR * gs.sm;
    var pJumpFrames = Math.ceil(1 / pJumpDur);
    var horizon = depth * pJumpFrames + 20; // +20 for slack
    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type === 'spawn-timer' && e.timer <= horizon) return true;
    }
    return false;
}

// Top-level: returns { dir -> P(survive depth hops) } for all legal dirs.
// Iterative deepening: evaluates at depth 2, 3, 4, ..., up to `maxDepth`,
// stopping early if a deadline is hit. Returns the deepest-completed answer
// per dir (dirs finished at depth D replace earlier D-1 results).
function perfectTeacherEval(gs, maxDepth, opts) {
    opts = Object.assign({}, TEACHER_DEFAULTS, opts || {});
    var dirs = typeof DIR_KEYS_WITH_STAY !== 'undefined' ? DIR_KEYS_WITH_STAY
                : ['UL', 'UR', 'DL', 'DR', 'STAY'];
    var deadline = typeof opts.deadlineMs === 'number' && isFinite(opts.deadlineMs)
        ? (typeof performance !== 'undefined' ? performance.now() : Date.now()) + opts.deadlineMs
        : Infinity;
    var result = {};
    var completedDepth = 0;
    for (var dpt = 2; dpt <= maxDepth; dpt++) {
        var now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now >= deadline) break;
        // Reset memo each depth — memo values are depth-specific
        // (actually they already include depth in the key, so keeping is fine,
        // but clearing avoids unbounded growth at max depth).
        var partial = {};
        var any = false;
        var allDirsCompleted = true;
        for (var k = 0; k < dirs.length; k++) {
            var dir = dirs[k];
            if (dir !== 'STAY') {
                var d = DIRS[dir];
                if (!isValidPos(gs.player.row + d.dr, gs.player.col + d.dc)) continue;
            }
            // Check deadline mid-loop
            var now2 = typeof performance !== 'undefined' ? performance.now() : Date.now();
            if (now2 >= deadline) { allDirsCompleted = false; break; }
            partial[dir] = teacherBranchProb(gs, dir, dpt, opts);
            any = true;
        }
        // Only accept FULLY completed depths — partial evaluation can overestimate
        // (shallow depth says STAY=1 but deep depth would see coily trapping)
        if (allDirsCompleted && any) {
            result = partial;
            completedDepth = dpt;
        }
        if (!allDirsCompleted) break;
    }
    teacherStats.maxDepthSeen = completedDepth;
    return result;
}

// Export for CommonJS environments.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        perfectTeacherEval: perfectTeacherEval,
        perfectTeacherSurvive: perfectTeacherSurvive,
        perfectTeacherReset: perfectTeacherReset,
        perfectTeacherStats: perfectTeacherStats,
        teacherMeasureBranching: teacherMeasureBranching,
        teacherStateKey: teacherStateKey,
    };
}
