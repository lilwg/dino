#!/usr/bin/env node
// Reproduce PRED-FAIL: player@(5,5) going DR to (6,6), redball at (6,6) jumping off edge.
var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));

var sm = 1.0;

// Test various redball states at/near (6,6)
var testStates = [
    // redball stationary at (6,6), about to jump (dirBits chosen to make it fall)
    { row: 6, col: 6, jumping: false, jumpT: 0, moveTimer: 11, falling: false, destRow: null, destCol: null, dirBits: 0 },
    { row: 6, col: 6, jumping: false, jumpT: 0, moveTimer: 11, falling: false, destRow: null, destCol: null, dirBits: 1 },
    { row: 6, col: 6, jumping: false, jumpT: 0, moveTimer: 8, falling: false, destRow: null, destCol: null, dirBits: 0 },
    // redball mid-jump, falling
    { row: 6, col: 6, jumping: true, jumpT: 0.05, falling: true, destRow: 7, destCol: 6, dirBits: null },
    { row: 6, col: 6, jumping: true, jumpT: 0.15, falling: true, destRow: 7, destCol: 6, dirBits: null },
    { row: 6, col: 6, jumping: true, jumpT: 0.25, falling: true, destRow: 7, destCol: 6, dirBits: null },
    { row: 6, col: 6, jumping: true, jumpT: 0.05, falling: true, destRow: 7, destCol: 7, dirBits: null },
    // redball about to jump, at (5,5)
    { row: 5, col: 5, jumping: false, jumpT: 0, moveTimer: 10, falling: false, destRow: null, destCol: null, dirBits: 0 },
    { row: 5, col: 5, jumping: false, jumpT: 0, moveTimer: 10, falling: false, destRow: null, destCol: null, dirBits: 1 },
];

function bruteSurv(initState, playerDir, depth) {
    var combos = 1; // deterministic (dirBits set or falling)
    var enemy = Object.assign({
        type: 'redball', jumpDur: ENEMY_JUMP_DUR * sm, jumpSrcRow: null, jumpSrcCol: null,
        moveInterval: enemyMoveInterval('redball', sm), hops: 0, spawnAnimTimer: 0,
        willHatch: false, lureRow: null, lureCol: null
    }, initState);
    var gs = {
        player: { row: 5, col: 5, jumping: false, jumpT: 0, jumpDur: PLAYER_JUMP_DUR * sm,
                  dead: false, deathTimer: 0, destRow: null, destCol: null,
                  prevRow: 4, prevCol: 4, jumpSrcRow: null, jumpSrcCol: null },
        enemies: [enemy],
        cubes: [], discs: [], sm: sm, tgt: 1, lv: 1, cubesColored: 0,
        score: 0, alive: true, freezeTimer: 0, round: 1, levelWon: false,
        survivalOnly: true
    };
    simHopDecisionQ = [];
    simHopDecisionIdx = 0;
    simRng = function() { return 0.5; };
    return simStep(gs, playerDir) ? 1 : 0;
}

function reactiveSurv(initState, playerDir, depth) {
    var enemy = Object.assign({
        type: 'redball', jumpDur: ENEMY_JUMP_DUR * sm, jumpSrcRow: null, jumpSrcCol: null,
        moveInterval: enemyMoveInterval('redball', sm), hops: 0, spawnAnimTimer: 0,
        willHatch: false, lureRow: null, lureCol: null
    }, initState);
    var gs = {
        player: { row: 5, col: 5, jumping: false, jumpT: 0, jumpDur: PLAYER_JUMP_DUR * sm,
                  dead: false, deathTimer: 0, destRow: null, destCol: null,
                  prevRow: 4, prevCol: 4, jumpSrcRow: null, jumpSrcCol: null },
        enemies: [enemy],
        cubes: [], discs: [], sm: sm, tgt: 1, lv: 1, cubesColored: 0,
        score: 0, alive: true, freezeTimer: 0, round: 1, levelWon: false
    };
    var paths = buildEnemyPaths(enemy, sm, 320);
    var react = findReactiveSurvival(gs, [paths], null, 0, 320, depth);
    return react[playerDir];
}

console.log('Player at (5,5), direction DR (to 6,6). Depth 1 test:\n');
for (var i = 0; i < testStates.length; i++) {
    var s = testStates[i];
    var desc = 'redball @(' + s.row + ',' + s.col + ') j=' + s.jumping + ' jT=' + s.jumpT +
               ' mt=' + (s.moveTimer||0) + ' fall=' + s.falling +
               ' dest=(' + s.destRow + ',' + s.destCol + ') db=' + s.dirBits;
    var brute = bruteSurv(s, 'DR', 1);
    var react = reactiveSurv(s, 'DR', 1);
    var diff = react - brute;
    var tag = Math.abs(diff) < 0.01 ? '✓' : (diff > 0 ? '✗ DANGEROUS' : '✗ conservative');
    console.log('  ' + desc);
    console.log('    brute=' + brute.toFixed(3) + ' reactive=' + react.toFixed(3) + ' ' + tag);
}
