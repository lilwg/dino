#!/usr/bin/env node
// Trace a single simStep to find where death happens.
var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));

// Setup: player at (2,1), going UR to (1,1). Egg at (1,1), moveTimer=11.
var sm = 1.0;
var gs = {
    player: { row: 2, col: 1, jumping: false, jumpT: 0, jumpDur: PLAYER_JUMP_DUR * sm,
              dead: false, deathTimer: 0, destRow: null, destCol: null,
              prevRow: 2, prevCol: 1, jumpSrcRow: null, jumpSrcCol: null },
    enemies: [{ type: 'egg', row: 1, col: 1, jumping: false, jumpT: 0,
                jumpDur: ENEMY_JUMP_DUR * sm, destRow: null, destCol: null,
                jumpSrcRow: null, jumpSrcCol: null,
                moveTimer: 11, moveInterval: 12, falling: false, willHatch: false,
                hops: 0, spawnAnimTimer: 0, dirBits: null, lureRow: null, lureCol: null }],
    cubes: [], discs: [], sm: sm, tgt: 1, lv: 1, cubesColored: 0,
    score: 0, alive: true, freezeTimer: 0, round: 1, levelWon: false,
    survivalOnly: true
};

// Set up RNG
simRng = (function(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
})(7);

// Manually run simStep with frame-by-frame logging
var p = gs.player;
var pJumpDur = PLAYER_JUMP_DUR * sm;
p.prevRow = p.row; p.prevCol = p.col;
p.jumpSrcRow = p.row; p.jumpSrcCol = p.col;
p.jumping = true; p.jumpT = 0; p.jumpDur = pJumpDur;
p.destRow = 1; p.destCol = 1;

console.log('Frame -1 (start): player=(2,1)→(1,1) jumpT=0, egg@(1,1) mt=11/12');

var frames = Math.ceil(1.0 / pJumpDur);
for (var f = 0; f < frames; f++) {
    p.jumpT += pJumpDur;
    if (p.jumpT >= 1) {
        p.jumpT = 1; p.jumping = false;
        p.row = 1; p.col = 1; p.destRow = null; p.destCol = null;
    }
    simUpdateEnemies(gs);
    var e = gs.enemies[0];
    // Get player tile
    var ptR, ptC;
    if (p.jumping) {
        if (p.jumpT < 0.33) { ptR = p.row; ptC = p.col; }
        else if (p.jumpT >= 0.67) { ptR = p.destRow; ptC = p.destCol; }
        else { ptR = -1; ptC = -1; }
    } else { ptR = p.row; ptC = p.col; }
    // Get egg tile
    var etR, etC;
    if (e.jumping) {
        if (e.jumpT < 0.33) { etR = e.row; etC = e.col; }
        else if (e.jumpT >= 0.67) { etR = e.destRow; etC = e.destCol; }
        else { etR = -1; etC = -1; }
    } else { etR = e.row; etC = e.col; }
    var coll = (ptR >= 0 && ptR === etR && ptC === etC) ? ' ** COLLISION **' : '';
    console.log('Frame ' + f + ': p=(' + ptR + ',' + ptC + ') pJT=' + p.jumpT.toFixed(3) +
        ' e=(' + etR + ',' + etC + ')' +
        ' eRow=' + e.row + ',' + e.col + ' eJumping=' + e.jumping + ' eJT=' + (e.jumpT||0).toFixed(3) +
        ' eMT=' + e.moveTimer + (e.destRow !== null ? ' eDest=(' + e.destRow + ',' + e.destCol + ')' : '') +
        coll);
    if (coll) break;
}
