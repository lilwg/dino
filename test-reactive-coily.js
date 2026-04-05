#!/usr/bin/env node
// Verify reactive expectimax with Coily matches brute-force simStep.
var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));

var TEST_DEPTH = parseInt(process.argv[2]) || 3;

function bruteRec(gs, depth, maxDepth) {
    if (depth >= maxDepth) return 1.0;
    if (!gs.alive) return 0;
    // Coily is deterministic, other enemies: 1 bit each
    var nRandom = 0;
    for (var i = 0; i < gs.enemies.length; i++)
        if (gs.enemies[i].type !== 'coily') nRandom++;
    var combos = 1 << nRandom;
    var bestP = 0;
    for (var dk = 0; dk < DIR_KEYS_WITH_STAY.length; dk++) {
        var dir = DIR_KEYS_WITH_STAY[dk];
        if (dir !== 'STAY' && !isValidPos(gs.player.row + DIRS[dir].dr, gs.player.col + DIRS[dir].dc)) continue;
        var sum = 0;
        for (var c = 0; c < combos; c++) {
            var choices = [];
            for (var b = 0; b < nRandom; b++) choices.push((c >> b) & 1);
            var gs1 = simDeepClone(gs);
            gs1.survivalOnly = true;
            simHopDecisionQ = choices; simHopDecisionIdx = 0;
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
    var nRandom = 0;
    for (var i = 0; i < gs.enemies.length; i++)
        if (gs.enemies[i].type !== 'coily') nRandom++;
    var combos = 1 << nRandom, sum = 0;
    for (var c = 0; c < combos; c++) {
        var choices = []; for (var b = 0; b < nRandom; b++) choices.push((c >> b) & 1);
        var gs1 = simDeepClone(gs); gs1.survivalOnly = true;
        simHopDecisionQ = choices; simHopDecisionIdx = 0;
        simRng = function() { return 0.5; };
        if (!simStep(gs1, dir1)) continue;
        sum += bruteRec(gs1, 1, maxDepth);
    }
    return sum / combos;
}

var sm = 1.0;
function mkEnemy(type, row, col, moveTimer, extra) {
    var e = {
        type: type, row: row, col: col, jumping: false, jumpT: 0,
        jumpDur: ENEMY_JUMP_DUR * sm, destRow: null, destCol: null,
        jumpSrcRow: null, jumpSrcCol: null,
        moveTimer: moveTimer || 0, moveInterval: enemyMoveInterval(type, sm),
        falling: false, willHatch: false, hops: 0, spawnAnimTimer: 0,
        dirBits: null, lureRow: null, lureCol: null
    };
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
}

function mkGs(pRow, pCol, enemies, prevR, prevC) {
    return {
        player: { row: pRow, col: pCol, jumping: false, jumpT: 0, jumpDur: PLAYER_JUMP_DUR * sm,
                  dead: false, deathTimer: 0, destRow: null, destCol: null,
                  prevRow: prevR != null ? prevR : pRow + 1, prevCol: prevC != null ? prevC : pCol,
                  jumpSrcRow: null, jumpSrcCol: null },
        enemies: enemies, cubes: [], discs: [], sm: sm, tgt: 1, lv: 1, cubesColored: 0,
        score: 0, alive: true, freezeTimer: 0, round: 1, levelWon: false
    };
}

// Test cases focused on Coily chase timing
var cases = [
    { name: 'coily below, moving up', pRow: 5, pCol: 5, prevR: 6, prevC: 5, enemies: [mkEnemy('coily', 6, 4, 5)] },
    { name: 'coily same row, swap', pRow: 6, pCol: 0, prevR: 6, prevC: 1, enemies: [mkEnemy('coily', 5, 0, 14)] }, // mt near interval for coily=16
    { name: 'coily 1 tile away', pRow: 4, pCol: 2, prevR: 5, prevC: 2, enemies: [mkEnemy('coily', 5, 1, 10)] },
    { name: 'coily + egg', pRow: 4, pCol: 2, prevR: 5, prevC: 2, enemies: [mkEnemy('coily', 5, 4, 8), mkEnemy('egg', 2, 1, 6)] },
    { name: 'coily + ugg', pRow: 3, pCol: 1, prevR: 4, prevC: 1, enemies: [mkEnemy('coily', 4, 3, 5), mkEnemy('ugg', 5, 5, 3)] },
    { name: 'coily near corner', pRow: 6, pCol: 2, prevR: 5, prevC: 2, enemies: [mkEnemy('coily', 5, 1, 12)] },
];

var dirs = ['UL', 'UR', 'DL', 'DR', 'STAY'];
var maxFrames = 320;
var mismatches = 0, dangerous = 0;

for (var ci = 0; ci < cases.length; ci++) {
    var t = cases[ci];
    console.log('\n=== ' + t.name + ' (p=(' + t.pRow + ',' + t.pCol + ') prev=(' + t.prevR + ',' + t.prevC + ')) ===');
    var gs = mkGs(t.pRow, t.pCol, t.enemies, t.prevR, t.prevC);
    var coilyInit = null, nonCoily = [];
    for (var ei = 0; ei < gs.enemies.length; ei++) {
        var e = gs.enemies[ei];
        if (e.type === 'coily') {
            coilyInit = { row: e.row, col: e.col, jumping: !!e.jumping, jumpT: e.jumpT || 0,
                moveTimer: e.moveTimer || 0, destRow: e.destRow, destCol: e.destCol,
                jumpDur: e.jumpDur || ENEMY_JUMP_DUR * sm,
                moveInterval: e.moveInterval || enemyMoveInterval('coily', sm) };
        } else nonCoily.push(e);
    }
    var pathLists = [];
    for (var ei2 = 0; ei2 < nonCoily.length; ei2++)
        pathLists.push(buildEnemyPaths(nonCoily[ei2], sm, maxFrames));
    var react = findReactiveSurvival(gs, pathLists, coilyInit, 0, maxFrames, TEST_DEPTH);
    for (var di = 0; di < dirs.length; di++) {
        var dir = dirs[di];
        if (dir !== 'STAY') {
            var pd = DIRS[dir];
            if (!isValidPos(t.pRow + pd.dr, t.pCol + pd.dc)) continue;
        }
        var brute = bruteTopLevel(gs, dir, TEST_DEPTH);
        var r = react[dir] !== undefined ? react[dir] : 0;
        var diff = r - brute;
        var tag;
        if (Math.abs(diff) < 0.01) tag = '✓';
        else if (diff > 0) { tag = '✗ DANGEROUS'; dangerous++; mismatches++; }
        else { tag = '✗ conservative'; mismatches++; }
        console.log('  ' + dir + ': brute=' + brute.toFixed(3) + ' reactive=' + r.toFixed(3) + ' diff=' + diff.toFixed(3) + ' ' + tag);
    }
}
console.log('\n' + (mismatches === 0 ? 'ALL MATCH' : mismatches + ' mismatches (' + dangerous + ' DANGEROUS)'));
