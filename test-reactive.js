#!/usr/bin/env node
// Compare findReactiveSurvival vs brute-force simStep expectimax at configurable depth.
var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));

var TEST_DEPTH = parseInt(process.argv[2]) || 2;
var N_ENEMY_COMBOS_BITS = 1; // 2^1 = 2 combos per hop per enemy

// Brute-force expectimax using simStep.
// Recursively enumerates all enemy random-choice combos at each hop,
// picks the best player direction, averages over enemy combos.
function bruteRec(gs, depth, maxDepth) {
    if (depth >= maxDepth) return 1.0;
    if (!gs.alive) return 0;

    var sm = gs.sm;
    var N = N_ENEMY_COMBOS_BITS * Math.max(1, gs.enemies.length);
    var combos = 1 << N;

    var bestP = 0;
    for (var dk = 0; dk < DIR_KEYS_WITH_STAY.length; dk++) {
        var dir = DIR_KEYS_WITH_STAY[dk];
        if (dir !== 'STAY' && !isValidPos(gs.player.row + DIRS[dir].dr, gs.player.col + DIRS[dir].dc)) continue;

        // Average over enemy combos
        var sum = 0;
        for (var c = 0; c < combos; c++) {
            var choices = [];
            for (var b = 0; b < N; b++) choices.push((c >> b) & 1);
            var gs1 = simDeepClone(gs);
            gs1.survivalOnly = true;
            simHopDecisionQ = choices;
            simHopDecisionIdx = 0;
            simRng = function() { return 0.5; };
            if (!simStep(gs1, dir)) continue; // died, contributes 0
            var sub = bruteRec(gs1, depth + 1, maxDepth);
            sum += sub;
        }
        var p = sum / combos;
        if (p > bestP) bestP = p;
    }
    return bestP;
}

function bruteTopLevel(gs, dir1, maxDepth) {
    var sm = gs.sm;
    var N = N_ENEMY_COMBOS_BITS * Math.max(1, gs.enemies.length);
    var combos = 1 << N;
    var sum = 0;
    for (var c = 0; c < combos; c++) {
        var choices = [];
        for (var b = 0; b < N; b++) choices.push((c >> b) & 1);
        var gs1 = simDeepClone(gs);
        gs1.survivalOnly = true;
        simHopDecisionQ = choices;
        simHopDecisionIdx = 0;
        simRng = function() { return 0.5; };
        if (!simStep(gs1, dir1)) continue;
        var sub = bruteRec(gs1, 1, maxDepth);
        sum += sub;
    }
    return sum / combos;
}

// Run the test
var sm = 1.0;
function makeGs() {
    return {
        player: { row: 4, col: 2, jumping: false, jumpT: 0, jumpDur: PLAYER_JUMP_DUR * sm,
                  dead: false, deathTimer: 0, destRow: null, destCol: null,
                  prevRow: 5, prevCol: 2, jumpSrcRow: null, jumpSrcCol: null },
        enemies: [{ type: 'egg', row: 2, col: 1, jumping: false, jumpT: 0,
                    jumpDur: ENEMY_JUMP_DUR * sm, destRow: null, destCol: null, jumpSrcRow: null, jumpSrcCol: null,
                    moveTimer: 6, moveInterval: 12, falling: false, willHatch: false,
                    hops: 0, spawnAnimTimer: 0, dirBits: null, lureRow: null, lureCol: null }],
        cubes: [], discs: [], sm: sm, tgt: 1, lv: 1, cubesColored: 0,
        score: 0, alive: true, freezeTimer: 0, round: 1, levelWon: false
    };
}

var gs = makeGs();

// Build enemy paths
var maxFrames = 320;
var paths = buildEnemyPaths(gs.enemies[0], sm, maxFrames);
console.log('Egg paths:', paths.length);
console.log('Testing at depth', TEST_DEPTH, '\n');

// Run reactive
var react = findReactiveSurvival(gs, [paths], null, 0, maxFrames, TEST_DEPTH);
console.log('Reactive (depth ' + TEST_DEPTH + '):');
for (var d in react) console.log('  ' + d + ': ' + react[d].toFixed(4));

// Run brute force
console.log('\nBrute force (depth ' + TEST_DEPTH + '):');
var dirs = ['UL', 'UR', 'DL', 'DR', 'STAY'];
var mismatches = 0;
for (var i = 0; i < dirs.length; i++) {
    var dir = dirs[i];
    if (dir !== 'STAY') {
        var pd = DIRS[dir];
        if (!isValidPos(gs.player.row + pd.dr, gs.player.col + pd.dc)) continue;
    }
    var p = bruteTopLevel(gs, dir, TEST_DEPTH);
    var rp = react[dir] !== undefined ? react[dir] : 0;
    var diff = Math.abs(p - rp);
    var tag = diff < 0.01 ? '✓' : '✗ MISMATCH';
    console.log('  ' + dir + ': brute=' + p.toFixed(4) + ' reactive=' + rp.toFixed(4) + ' diff=' + diff.toFixed(4) + ' ' + tag);
    if (diff >= 0.01) mismatches++;
}
console.log('\n' + (mismatches === 0 ? 'ALL MATCH' : mismatches + ' MISMATCHES'));
