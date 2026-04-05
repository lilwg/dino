#!/usr/bin/env node
// Verify per-path survival matches expectimax for single hops.
var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));

// Setup: player at (2,1), egg at (1,1), no other enemies.
// Player choices: UL, UR, DL, DR. For each, compute:
//   - My per-path survival
//   - Brute-force expectimax (simulate all enemy choices)

function bruteForceSurvival(enemyInit, pRow, pCol, dir, sm, nCombos) {
    var survived = 0;
    for (var c = 0; c < nCombos; c++) {
        var choices = [];
        for (var b = 0; b < 10; b++) choices.push((c >> b) & 1);

        // Setup fresh game state
        var gs = {
            player: { row: pRow, col: pCol, jumping: false, jumpT: 0, jumpDur: PLAYER_JUMP_DUR * sm,
                      dead: false, deathTimer: 0, destRow: null, destCol: null,
                      prevRow: pRow, prevCol: pCol, jumpSrcRow: null, jumpSrcCol: null },
            enemies: [Object.assign({}, enemyInit)],
            cubes: [], discs: [], sm: sm, tgt: 1, lv: 1, cubesColored: 0,
            score: 0, alive: true, freezeTimer: 0, round: 1, levelWon: false,
            survivalOnly: true
        };
        simHopDecisionQ = choices;
        simHopDecisionIdx = 0;
        simRng = function() { return 0.5; };
        if (simStep(gs, dir)) survived++;
    }
    return survived / nCombos;
}

function perPathSurvival(enemyInit, pRow, pCol, dir, sm, maxFrames) {
    var paths = buildEnemyPaths(enemyInit, sm, maxFrames);
    var timeline = new Int8Array(maxFrames);
    for (var i = 0; i < maxFrames; i++) timeline[i] = -1;
    var hop = appendHop(timeline, pRow, pCol, dir, sm, 0, maxFrames);
    if (!hop) return 0;
    var playerJumps = [];
    if (dir !== 'STAY') {
        playerJumps.push({
            startFrame: 0, endFrame: hop.endFrame,
            srcIdx: posToIdx[pRow * ROWS + pCol],
            destIdx: posToIdx[hop.endRow * ROWS + hop.endCol]
        });
    }
    var hitProb = pathsHitProb(paths, timeline, playerJumps, 0, hop.endFrame);
    return 1.0 - hitProb;
}

// Test various enemy starting states
var testCases = [
    { type: 'egg', row: 1, col: 1, moveTimer: 11, name: 'egg (1,1) mt=11' },
    { type: 'egg', row: 1, col: 1, moveTimer: 0, name: 'egg (1,1) mt=0' },
    { type: 'egg', row: 2, col: 1, moveTimer: 6, name: 'egg (2,1) mt=6' },
    { type: 'egg', row: 3, col: 2, moveTimer: 3, name: 'egg (3,2) mt=3' },
    { type: 'ugg', row: 5, col: 5, moveTimer: 5, name: 'ugg (5,5) mt=5' },
    { type: 'wrongway', row: 5, col: 0, moveTimer: 5, name: 'wrongway (5,0) mt=5' },
];

var dirs = ['UL', 'UR', 'DL', 'DR'];
var pRow = 4, pCol = 2;

for (var tc = 0; tc < testCases.length; tc++) {
    var t = testCases[tc];
    var interval = enemyMoveInterval(t.type, 1.0);
    var enemy = {
        type: t.type, row: t.row, col: t.col,
        jumping: false, jumpT: 0, jumpDur: ENEMY_JUMP_DUR,
        destRow: null, destCol: null, jumpSrcRow: null, jumpSrcCol: null,
        moveTimer: t.moveTimer, moveInterval: interval,
        falling: false, willHatch: false, hops: 0, spawnAnimTimer: 0,
        dirBits: null, lureRow: null, lureCol: null
    };
    console.log('\n' + t.name + ' — player at (' + pRow + ',' + pCol + '):');
    for (var di = 0; di < dirs.length; di++) {
        var dir = dirs[di];
        // Skip invalid moves
        var d = DIRS[dir];
        if (!isValidPos(pRow + d.dr, pCol + d.dc)) { console.log('  ' + dir + ': invalid'); continue; }
        var ppS = perPathSurvival(enemy, pRow, pCol, dir, 1.0, 100);
        var bfS = bruteForceSurvival(enemy, pRow, pCol, dir, 1.0, 64);
        var match = Math.abs(ppS - bfS) < 0.01 ? '✓' : '✗ MISMATCH';
        console.log('  ' + dir + ': perPath=' + ppS.toFixed(3) + ' bruteForce=' + bfS.toFixed(3) + ' ' + match);
    }
}
