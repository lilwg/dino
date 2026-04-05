#!/usr/bin/env node
// Smoke test for perfect-teacher.js.
//
// Verifies:
//   1. perfectTeacherEval returns sensible probabilities on known scenarios.
//   2. On no-spawn, small-enemy cases it agrees with a reference brute force.
//   3. Branching factor measurement correctly counts simHopDecision / simRng calls.
//
// Usage: node test-perfect-teacher.js [depth]

var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));
eval(fs.readFileSync('perfect-teacher.js', 'utf8'));

var DEPTH = parseInt(process.argv[2]) || 4;
var sm = 1.0;

function mkEnemy(type, row, col, moveTimer, dirBits) {
    return {
        type: type, row: row, col: col,
        jumping: false, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * sm,
        destRow: null, destCol: null, jumpSrcRow: null, jumpSrcCol: null,
        moveTimer: moveTimer || 0,
        moveInterval: enemyMoveInterval(type, sm),
        falling: false, willHatch: false, hops: 0, spawnAnimTimer: 0,
        dirBits: dirBits == null ? null : dirBits,
        lureRow: null, lureCol: null
    };
}

function mkGs(pRow, pCol, enemies) {
    return {
        player: {
            row: pRow, col: pCol, jumping: false, jumpT: 0,
            jumpDur: PLAYER_JUMP_DUR * sm,
            dead: false, deathTimer: 0,
            destRow: null, destCol: null,
            prevRow: pRow + 1, prevCol: pCol,
            jumpSrcRow: null, jumpSrcCol: null
        },
        enemies: enemies, cubes: [], discs: [],
        sm: sm, tgt: 1, lv: 1, cubesColored: 0,
        score: 0, alive: true, freezeTimer: 0,
        round: 1, levelWon: false
    };
}

// ─── Test 1: Branching factor measurement ──────────────────────────────────
console.log('── Test 1: branching factor ──');
function measureTest(label, gs, dir) {
    var b = teacherMeasureBranching(gs, dir);
    console.log('  ' + label + ' dir=' + dir +
                ': hopBits=' + b.hopBits + ' rngCalls=' + b.rngCalls);
    return b;
}
measureTest('empty', mkGs(4, 2, []), 'UL');
measureTest('1 egg', mkGs(4, 2, [mkEnemy('egg', 2, 1, 6)]), 'UL');
measureTest('1 ugg', mkGs(4, 2, [mkEnemy('ugg', 6, 6, 6)]), 'UL');
measureTest('1 wrongway', mkGs(4, 2, [mkEnemy('wrongway', 6, 0, 6)]), 'UL');
measureTest('1 ball (dirBits=42)', mkGs(4, 2, [mkEnemy('redball', 2, 1, 6, 42)]), 'UL');
measureTest('1 coily', mkGs(4, 2, [mkEnemy('coily', 2, 1, 6)]), 'UL');
measureTest('egg+ugg+wrongway',
    mkGs(4, 2, [mkEnemy('egg', 2, 1, 6), mkEnemy('ugg', 6, 6, 6), mkEnemy('wrongway', 6, 0, 6)]), 'UL');

// ─── Test 2: Sanity — P(survive) in { 0, 1 } for isolated cases ─────────────
console.log('\n── Test 2: sanity cases ──');
function probe(label, gs, depth) {
    perfectTeacherReset();
    var t0 = Date.now();
    var res = perfectTeacherEval(gs, depth);
    var ms = Date.now() - t0;
    var s = perfectTeacherStats();
    console.log('  ' + label + ' depth=' + depth + ' (' + ms + 'ms)');
    for (var d in res) {
        console.log('    ' + d + ': ' + res[d].toFixed(4));
    }
    console.log('    stats: evals=' + s.evals + ' memoHits=' + s.memoHits +
                ' exhaustive=' + s.exhaustiveNodes + ' mc=' + s.mcNodes +
                ' simSteps=' + s.simStepCalls + ' deaths=' + s.deathsObserved);
}

probe('no enemies', mkGs(4, 2, []), DEPTH);
probe('1 distant egg', mkGs(4, 2, [mkEnemy('egg', 1, 0, 0)]), DEPTH);
probe('1 adjacent egg (danger)', mkGs(4, 2, [mkEnemy('egg', 3, 1, 11)]), DEPTH);
probe('1 distant ugg', mkGs(4, 2, [mkEnemy('ugg', 6, 6, 0)]), DEPTH);

// ─── Test 3: Compare against brute-force reference ──────────────────────────
console.log('\n── Test 3: vs reference brute force (depth ' + DEPTH + ') ──');

// Reference brute force: same approach as teacher but independently written,
// using measured branching factor (not a fixed over-provision).
function bruteRec(gs, depth, maxDepth) {
    if (depth >= maxDepth) return gs.alive ? 1.0 : 0.0;
    if (!gs.alive) return 0.0;
    var bestP = 0;
    for (var dk = 0; dk < DIR_KEYS_WITH_STAY.length; dk++) {
        var dir = DIR_KEYS_WITH_STAY[dk];
        if (dir !== 'STAY') {
            var d = DIRS[dir];
            if (!isValidPos(gs.player.row + d.dr, gs.player.col + d.dc)) continue;
        }
        // Measure branching factor.
        var savedQ = simHopDecisionQ, savedIdx = simHopDecisionIdx, savedRng = simRng;
        var gsM = simDeepClone(gs); gsM.survivalOnly = true;
        simHopDecisionQ = new Array(64).fill(0); simHopDecisionIdx = 0;
        simRng = function() { return 0.5; };
        simStep(gsM, dir);
        var N = simHopDecisionIdx;
        simHopDecisionQ = savedQ; simHopDecisionIdx = savedIdx; simRng = savedRng;
        if (N > 16) return -1; // don't brute-force this hard
        var combos = 1 << N;
        var sum = 0;
        for (var c = 0; c < combos; c++) {
            var choices = [];
            for (var b = 0; b < N; b++) choices.push((c >> b) & 1);
            var gs1 = simDeepClone(gs); gs1.survivalOnly = true;
            simHopDecisionQ = choices; simHopDecisionIdx = 0;
            var savedRng2 = simRng;
            simRng = function() { return 0.5; };
            var alive = simStep(gs1, dir);
            simRng = savedRng2;
            if (alive) {
                var sub = bruteRec(gs1, depth + 1, maxDepth);
                if (sub < 0) return -1;
                sum += sub;
            }
        }
        var p = sum / combos;
        if (p > bestP) bestP = p;
    }
    return bestP;
}

function bruteTop(gs, dir1, maxDepth) {
    // Measure branching factor for the first hop.
    var savedQ = simHopDecisionQ, savedIdx = simHopDecisionIdx, savedRng = simRng;
    var gsM = simDeepClone(gs); gsM.survivalOnly = true;
    simHopDecisionQ = new Array(64).fill(0); simHopDecisionIdx = 0;
    simRng = function() { return 0.5; };
    simStep(gsM, dir1);
    var N = simHopDecisionIdx;
    simHopDecisionQ = savedQ; simHopDecisionIdx = savedIdx; simRng = savedRng;
    if (N > 16) return -1;
    var combos = 1 << N;
    var sum = 0;
    for (var c = 0; c < combos; c++) {
        var choices = [];
        for (var b = 0; b < N; b++) choices.push((c >> b) & 1);
        var gs1 = simDeepClone(gs); gs1.survivalOnly = true;
        simHopDecisionQ = choices; simHopDecisionIdx = 0;
        var savedRng2 = simRng;
        simRng = function() { return 0.5; };
        var alive = simStep(gs1, dir1);
        simRng = savedRng2;
        if (alive) {
            var sub = bruteRec(gs1, 1, maxDepth);
            if (sub < 0) return -1;
            sum += sub;
        }
    }
    return sum / combos;
}

var cases = [
    { label: 'empty',        gs: mkGs(4, 2, []) },
    { label: '1 distant egg', gs: mkGs(4, 2, [mkEnemy('egg', 1, 0, 0)]) },
    { label: '1 adjacent egg', gs: mkGs(4, 2, [mkEnemy('egg', 3, 1, 11)]) },
    { label: '1 ugg',        gs: mkGs(4, 2, [mkEnemy('ugg', 6, 6, 0)]) },
    { label: '1 wrongway',   gs: mkGs(4, 2, [mkEnemy('wrongway', 6, 0, 0)]) },
    { label: 'ball dirBits=42', gs: mkGs(4, 2, [mkEnemy('redball', 2, 1, 6, 42)]) },
];

var dirs = ['UL', 'UR', 'DL', 'DR', 'STAY'];
var totalMismatches = 0;
for (var ci = 0; ci < cases.length; ci++) {
    var c = cases[ci];
    console.log('  ' + c.label + ':');
    perfectTeacherReset();
    var teacher = perfectTeacherEval(c.gs, DEPTH);
    for (var di = 0; di < dirs.length; di++) {
        var dir = dirs[di];
        if (teacher[dir] === undefined) continue;
        var brute = bruteTop(c.gs, dir, DEPTH);
        if (brute < 0) {
            console.log('    ' + dir + ': teacher=' + teacher[dir].toFixed(4) +
                        ' brute=SKIPPED(too expensive)');
            continue;
        }
        var diff = Math.abs(teacher[dir] - brute);
        var tag = diff < 0.01 ? 'OK ' : (diff < 0.05 ? 'soft' : 'MISS');
        if (tag !== 'OK ') totalMismatches++;
        console.log('    ' + dir + ': teacher=' + teacher[dir].toFixed(4) +
                    ' brute=' + brute.toFixed(4) +
                    ' diff=' + diff.toFixed(4) + ' [' + tag + ']');
    }
}

console.log('\n' + (totalMismatches === 0 ? 'ALL PASSED' : totalMismatches + ' mismatches'));
process.exit(totalMismatches > 0 ? 1 : 0);
