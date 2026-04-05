#!/usr/bin/env node
// Verify reactive expectimax handles egg hatching into Coily.
var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));

var sm = 1.0;

function bruteSurvival(gs, dir, depth) {
    if (depth === 0) return 1.0;
    if (!gs.alive) return 0;
    var nRandom = 0;
    for (var i = 0; i < gs.enemies.length; i++)
        if (gs.enemies[i].type !== 'coily' && gs.enemies[i].type !== 'spawn-timer') nRandom++;
    var combos = 1 << nRandom;
    var sum = 0;
    for (var c = 0; c < combos; c++) {
        var choices = [];
        for (var b = 0; b < nRandom; b++) choices.push((c >> b) & 1);
        var gs1 = simDeepClone(gs); gs1.survivalOnly = true;
        simHopDecisionQ = choices; simHopDecisionIdx = 0;
        simRng = function() { return 0.5; };
        if (!simStep(gs1, dir)) continue;
        // Pick best next move recursively
        var bestNext = 0;
        for (var dk = 0; dk < DIR_KEYS_WITH_STAY.length; dk++) {
            var d = DIR_KEYS_WITH_STAY[dk];
            if (d !== 'STAY' && !isValidPos(gs1.player.row + DIRS[d].dr, gs1.player.col + DIRS[d].dc)) continue;
            var next = bruteSurvival(gs1, d, depth - 1);
            if (next > bestNext) bestNext = next;
        }
        sum += bestNext;
    }
    return sum / combos;
}

// Test scenario: player at (5,0), egg near bottom about to hatch
var gs = {
    player: { row: 5, col: 0, jumping: false, jumpT: 0, jumpDur: PLAYER_JUMP_DUR * sm,
              dead: false, deathTimer: 0, destRow: null, destCol: null,
              prevRow: 4, prevCol: 0, jumpSrcRow: null, jumpSrcCol: null },
    enemies: [{ type: 'egg', row: 5, col: 1, jumping: true, jumpT: 0.1,
                jumpDur: ENEMY_JUMP_DUR * sm, destRow: 6, destCol: 1, jumpSrcRow: null, jumpSrcCol: null,
                moveTimer: 0, moveInterval: enemyMoveInterval('egg', sm),
                falling: false, willHatch: true, hops: 5, spawnAnimTimer: 0, dirBits: null,
                lureRow: null, lureCol: null },
              { type: 'redball', row: 2, col: 1, jumping: true, jumpT: 0.37,
                jumpDur: ENEMY_JUMP_DUR * sm, destRow: 3, destCol: 2, jumpSrcRow: null, jumpSrcCol: null,
                moveTimer: 0, moveInterval: enemyMoveInterval('redball', sm),
                falling: false, willHatch: false, hops: 1, spawnAnimTimer: 0, dirBits: 0,
                lureRow: null, lureCol: null }],
    cubes: [], discs: [], sm: sm, tgt: 1, lv: 1, cubesColored: 0,
    score: 0, alive: true, freezeTimer: 0, round: 1, levelWon: false
};

var DEPTH = 6;

console.log('Player at (5,0), egg at (5,1) jumping to (6,1), will hatch into Coily.\n');
console.log('Running at depth', DEPTH + ':\n');

var paths = buildEnemyPaths(gs.enemies[0], sm, 320);
console.log('Egg paths built:', paths.length);
var pathsWithHatch = 0;
for (var i = 0; i < paths.length; i++) if (paths[i].hatchInfo) pathsWithHatch++;
console.log('Paths with hatchInfo:', pathsWithHatch);

var react = findReactiveSurvival(gs, [paths], null, 0, 320, DEPTH);

console.log('\nReactive vs brute-force expectimax:');
var dirs = ['UL', 'UR', 'DL', 'DR', 'STAY'];
var maxDiff = 0;
for (var di = 0; di < dirs.length; di++) {
    var dir = dirs[di];
    if (dir !== 'STAY') {
        var pd = DIRS[dir];
        if (!isValidPos(gs.player.row + pd.dr, gs.player.col + pd.dc)) continue;
    }
    var brute = bruteSurvival(gs, dir, DEPTH);
    var r = react[dir] !== undefined ? react[dir] : 0;
    var diff = r - brute;
    var tag;
    if (Math.abs(diff) < 0.01) tag = '✓';
    else if (diff > 0) tag = '✗ DANGEROUS';
    else tag = '✗ conservative';
    console.log('  ' + dir + ': brute=' + brute.toFixed(3) + ' reactive=' + r.toFixed(3) + ' diff=' + diff.toFixed(3) + ' ' + tag);
    if (Math.abs(diff) > maxDiff) maxDiff = Math.abs(diff);
}
console.log('\nMax diff:', maxDiff.toFixed(3));
