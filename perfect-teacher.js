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
    exhaustiveBitsLimit: 20,  // 2^20 ≈ 1M branches max per node
    mcSamples: 1024,
    mcMaxChildDepth: 4,       // cap recursion depth after an MC node to bound cost
    maxMemoEntries: 2_000_000,
    seed: 0xC0FFEE,
    deadlineMs: Infinity,     // wall-clock budget; returns current best when exceeded
};

function perfectTeacherReset() {
    teacherMemo = new Map();
    teacherStats = {
        evals: 0, memoHits: 0, memoStores: 0,
        exhaustiveNodes: 0, mcNodes: 0,
        simStepCalls: 0, deathsObserved: 0,
        maxDepthSeen: 0,
    };
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
    var alive = simStep(gs1, dir);
    simHopDecisionQ = savedQ;
    simHopDecisionIdx = savedIdx;
    simRng = savedRng;
    teacherStats.simStepCalls++;
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
    var dirs = typeof DIR_KEYS_WITH_STAY !== 'undefined' ? DIR_KEYS_WITH_STAY
                : ['UL', 'UR', 'DL', 'DR', 'STAY'];
    for (var k = 0; k < dirs.length; k++) {
        var dir = dirs[k];
        if (dir !== 'STAY') {
            var d = DIRS[dir];
            if (!isValidPos(gs.player.row + d.dr, gs.player.col + d.dc)) continue;
        }
        var p = teacherBranchProb(gs, dir, depth, opts);
        if (p > bestP) bestP = p;
        // Early-out: if we found P=1.0, no need to check more dirs.
        if (bestP >= 1.0) break;
    }

    if (teacherMemo.size < opts.maxMemoEntries) {
        teacherMemo.set(memoKey, bestP);
        teacherStats.memoStores++;
    }
    return bestP;
}

// Per-direction expected survival across all enemy RNG outcomes.
function teacherBranchProb(gs, dir, depth, opts) {
    var b = teacherMeasureBranching(gs, dir);
    var totalBits = b.hopBits + b.rngCalls * 8; // treat simRng as ~8 bits worst case
    var nextDepth = depth - 1;

    if (b.rngCalls === 0 && b.hopBits <= opts.exhaustiveBitsLimit) {
        // Exhaustive enumeration over 2^hopBits combos.
        teacherStats.exhaustiveNodes++;
        var combos = 1 << b.hopBits;
        var sum = 0.0;
        for (var c = 0; c < combos; c++) {
            var bits = new Array(b.hopBits);
            for (var bi = 0; bi < b.hopBits; bi++) bits[bi] = (c >> bi) & 1;
            // simRng should not be called when rngCalls==0 for this dir,
            // but provide a safe default anyway.
            var res = teacherExecHop(gs, dir, bits, function() { return 0.5; });
            if (res.alive) sum += perfectTeacherSurvive(res.gs, nextDepth, opts);
        }
        return sum / combos;
    }

    // Monte Carlo. Each sample: random hop bits + seeded simRng.
    teacherStats.mcNodes++;
    var nSamples = opts.mcSamples;
    var sum2 = 0.0;
    // Derive seed from state+dir so samples are reproducible.
    var stateSeed = (hashString(teacherStateKey(gs)) ^ dir.charCodeAt(0) * 2654435761) | 0;
    var rng = mkXorshift(stateSeed ^ opts.seed);
    for (var s = 0; s < nSamples; s++) {
        var bits2 = new Array(b.hopBits);
        for (var bi2 = 0; bi2 < b.hopBits; bi2++) bits2[bi2] = rng() < 0.5 ? 0 : 1;
        // Per-sample simRng stream, independent of hop bits.
        var sampleRng = mkXorshift(stateSeed ^ opts.seed ^ (s * 2654435761));
        var res2 = teacherExecHop(gs, dir, bits2, sampleRng);
        if (res2.alive) sum2 += perfectTeacherSurvive(res2.gs, nextDepth, opts);
    }
    return sum2 / nSamples;
}

// FNV-1a 32-bit string hash.
function hashString(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) | 0;
    }
    return h | 0;
}

// Top-level: returns { dir -> P(survive depth hops) } for all legal dirs.
function perfectTeacherEval(gs, depth, opts) {
    opts = Object.assign({}, TEACHER_DEFAULTS, opts || {});
    var result = {};
    var dirs = typeof DIR_KEYS_WITH_STAY !== 'undefined' ? DIR_KEYS_WITH_STAY
                : ['UL', 'UR', 'DL', 'DR', 'STAY'];
    for (var k = 0; k < dirs.length; k++) {
        var dir = dirs[k];
        if (dir !== 'STAY') {
            var d = DIRS[dir];
            if (!isValidPos(gs.player.row + d.dr, gs.player.col + d.dc)) continue;
        }
        result[dir] = teacherBranchProb(gs, dir, depth, opts);
    }
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
