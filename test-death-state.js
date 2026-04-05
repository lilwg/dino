#!/usr/bin/env node
// Reproduce the EXACT death state to see why AI says -10000.
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

// Player at (6,0), coily at (6,1) (hatched from egg), redball at (4,3) moving DL
var gs = {
    player: { row: 6, col: 0, jumping: false, jumpT: 0, jumpDur: PLAYER_JUMP_DUR * sm,
              dead: false, deathTimer: 0, destRow: null, destCol: null,
              prevRow: 5, prevCol: 0, jumpSrcRow: null, jumpSrcCol: null },
    enemies: [{ type: 'coily', row: 6, col: 1, jumping: false, jumpT: 0,
                jumpDur: ENEMY_JUMP_DUR * sm, destRow: null, destCol: null, jumpSrcRow: null, jumpSrcCol: null,
                moveTimer: 6, moveInterval: enemyMoveInterval('coily', sm),
                falling: false, willHatch: false, hops: 0, spawnAnimTimer: 0, dirBits: null,
                lureRow: null, lureCol: null },
              { type: 'redball', row: 4, col: 3, jumping: false, jumpT: 0,
                jumpDur: ENEMY_JUMP_DUR * sm, destRow: null, destCol: null, jumpSrcRow: null, jumpSrcCol: null,
                moveTimer: 0, moveInterval: enemyMoveInterval('redball', sm),
                falling: false, willHatch: false, hops: 3, spawnAnimTimer: 0, dirBits: 0,
                lureRow: null, lureCol: null }],
    cubes: [], discs: [], sm: sm, tgt: 1, lv: 1, cubesColored: 0,
    score: 0, alive: true, freezeTimer: 0, round: 1, levelWon: false
};

console.log('Player (6,0), coily (6,1) mt=6/16, redball (4,3) dirBits=0.\n');

var DEPTH = 6;
var coilyInit = { row: 6, col: 1, jumping: false, jumpT: 0, moveTimer: 6,
    destRow: null, destCol: null, jumpDur: ENEMY_JUMP_DUR * sm,
    moveInterval: enemyMoveInterval('coily', sm) };
var redballPaths = buildEnemyPaths(gs.enemies[1], sm, 320);
var react = findReactiveSurvival(gs, [redballPaths], coilyInit, 0, 320, DEPTH);

console.log('Full reactive result at depth ' + DEPTH + ':');
for (var k in react) console.log('  ' + k + ': ' + react[k].toFixed(3));
console.log('\nReactive vs brute-force expectimax (depth ' + DEPTH + '):');
var dirs = ['UR', 'STAY'];
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
}
