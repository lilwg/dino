#!/usr/bin/env node
// Compare findReactiveSurvival vs brute-force simStep with MULTIPLE enemies.
var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));

var TEST_DEPTH = parseInt(process.argv[2]) || 3;

// Brute force recursive expectimax via simStep
function bruteRec(gs, depth, maxDepth) {
    if (depth >= maxDepth) return 1.0;
    if (!gs.alive) return 0;
    var N = gs.enemies.length; // 1 bit per enemy
    var combos = 1 << N;

    var bestP = 0;
    for (var dk = 0; dk < DIR_KEYS_WITH_STAY.length; dk++) {
        var dir = DIR_KEYS_WITH_STAY[dk];
        if (dir !== 'STAY' && !isValidPos(gs.player.row + DIRS[dir].dr, gs.player.col + DIRS[dir].dc)) continue;
        var sum = 0;
        for (var c = 0; c < combos; c++) {
            var choices = [];
            for (var b = 0; b < N; b++) choices.push((c >> b) & 1);
            var gs1 = simDeepClone(gs);
            gs1.survivalOnly = true;
            simHopDecisionQ = choices;
            simHopDecisionIdx = 0;
            simRng = function() { return 0.5; };
            if (!simStep(gs1, dir)) continue;
            sum += bruteRec(gs1, depth + 1, maxDepth);
        }
        var p = sum / combos;
        if (p > bestP) bestP = p;
    }
    return bestP;
}

function bruteTopLevel(gs, dir1, maxDepth) {
    var N = gs.enemies.length;
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
        sum += bruteRec(gs1, 1, maxDepth);
    }
    return sum / combos;
}

var sm = 1.0;
function mkEnemy(type, row, col, moveTimer) {
    return {
        type: type, row: row, col: col, jumping: false, jumpT: 0,
        jumpDur: ENEMY_JUMP_DUR * sm, destRow: null, destCol: null,
        jumpSrcRow: null, jumpSrcCol: null,
        moveTimer: moveTimer, moveInterval: enemyMoveInterval(type, sm),
        falling: false, willHatch: false, hops: 0, spawnAnimTimer: 0,
        dirBits: null, lureRow: null, lureCol: null
    };
}

function mkGs(pRow, pCol, enemies) {
    return {
        player: { row: pRow, col: pCol, jumping: false, jumpT: 0, jumpDur: PLAYER_JUMP_DUR * sm,
                  dead: false, deathTimer: 0, destRow: null, destCol: null,
                  prevRow: pRow + 1, prevCol: pCol, jumpSrcRow: null, jumpSrcCol: null },
        enemies: enemies,
        cubes: [], discs: [], sm: sm, tgt: 1, lv: 1, cubesColored: 0,
        score: 0, alive: true, freezeTimer: 0, round: 1, levelWon: false
    };
}

var testCases = [
    { name: '2 eggs', pRow: 4, pCol: 2, enemies: [mkEnemy('egg', 2, 1, 6), mkEnemy('egg', 2, 0, 8)] },
    { name: 'egg+ugg', pRow: 3, pCol: 1, enemies: [mkEnemy('egg', 1, 0, 6), mkEnemy('ugg', 5, 4, 3)] },
    { name: '3 eggs', pRow: 5, pCol: 2, enemies: [mkEnemy('egg', 2, 1, 3), mkEnemy('egg', 3, 2, 5), mkEnemy('egg', 1, 0, 10)] },
    { name: 'egg+wrongway', pRow: 4, pCol: 2, enemies: [mkEnemy('egg', 2, 1, 6), mkEnemy('wrongway', 5, 0, 3)] },
    { name: '2 eggs close', pRow: 3, pCol: 1, enemies: [mkEnemy('egg', 2, 1, 3), mkEnemy('egg', 1, 0, 6)] },
];

var dirs = ['UL', 'UR', 'DL', 'DR', 'STAY'];
var maxFrames = 320;

var totalMismatches = 0;
for (var tc = 0; tc < testCases.length; tc++) {
    var t = testCases[tc];
    console.log('\n=== ' + t.name + ' (player at ' + t.pRow + ',' + t.pCol + ') ===');

    var gs = mkGs(t.pRow, t.pCol, t.enemies);
    // Build paths
    var pathLists = [];
    for (var ei = 0; ei < gs.enemies.length; ei++) {
        pathLists.push(buildEnemyPaths(gs.enemies[ei], sm, maxFrames));
    }

    var react = findReactiveSurvival(gs, pathLists, null, 0, maxFrames, TEST_DEPTH);

    for (var i = 0; i < dirs.length; i++) {
        var dir = dirs[i];
        if (dir !== 'STAY') {
            var pd = DIRS[dir];
            if (!isValidPos(gs.player.row + pd.dr, gs.player.col + pd.dc)) continue;
        }
        var brute = bruteTopLevel(gs, dir, TEST_DEPTH);
        var r = react[dir] !== undefined ? react[dir] : 0;
        var diff = Math.abs(brute - r);
        var tag = diff < 0.01 ? '✓' : '✗';
        console.log('  ' + dir + ': brute=' + brute.toFixed(3) + ' reactive=' + r.toFixed(3) + ' diff=' + diff.toFixed(3) + ' ' + tag);
        if (diff >= 0.01) totalMismatches++;
    }
}

console.log('\n' + (totalMismatches === 0 ? 'ALL MATCH' : totalMismatches + ' MISMATCHES at depth ' + TEST_DEPTH));
