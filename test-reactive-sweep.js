#!/usr/bin/env node
// Sweep test: many configurations to find where reactive disagrees with brute force.
var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));

var TEST_DEPTH = parseInt(process.argv[2]) || 3;

function bruteRec(gs, depth, maxDepth) {
    if (depth >= maxDepth) return 1.0;
    if (!gs.alive) return 0;
    var N = gs.enemies.length;
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
    var N = gs.enemies.length, combos = 1 << N, sum = 0;
    for (var c = 0; c < combos; c++) {
        var choices = []; for (var b = 0; b < N; b++) choices.push((c >> b) & 1);
        var gs1 = simDeepClone(gs); gs1.survivalOnly = true;
        simHopDecisionQ = choices; simHopDecisionIdx = 0;
        simRng = function() { return 0.5; };
        if (!simStep(gs1, dir1)) continue;
        sum += bruteRec(gs1, 1, maxDepth);
    }
    return sum / combos;
}

var sm = 1.0;
function mkEnemy(type, row, col, moveTimer) {
    return { type: type, row: row, col: col, jumping: false, jumpT: 0,
             jumpDur: ENEMY_JUMP_DUR * sm, destRow: null, destCol: null,
             jumpSrcRow: null, jumpSrcCol: null,
             moveTimer: moveTimer, moveInterval: enemyMoveInterval(type, sm),
             falling: false, willHatch: false, hops: 0, spawnAnimTimer: 0,
             dirBits: null, lureRow: null, lureCol: null };
}

function mkGs(pRow, pCol, enemies) {
    return {
        player: { row: pRow, col: pCol, jumping: false, jumpT: 0, jumpDur: PLAYER_JUMP_DUR * sm,
                  dead: false, deathTimer: 0, destRow: null, destCol: null,
                  prevRow: pRow + 1, prevCol: pCol, jumpSrcRow: null, jumpSrcCol: null },
        enemies: enemies, cubes: [], discs: [], sm: sm, tgt: 1, lv: 1, cubesColored: 0,
        score: 0, alive: true, freezeTimer: 0, round: 1, levelWon: false
    };
}

var types = ['egg', 'ugg', 'wrongway'];
var dirs = ['UL', 'UR', 'DL', 'DR', 'STAY'];
var maxFrames = 320;

// Generate test cases
var mismatches = [];
var total = 0;
var dangerous = 0; // reactive > brute (over-estimation)

// Small sweep: 1 or 2 enemies at random positions
function randInt(n) { return Math.floor(Math.random() * n); }

var seed = 42;
function rng() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function ri(n) { return Math.floor(rng() * n); }

for (var trial = 0; trial < 30; trial++) {
    var pRow = 1 + ri(6), pCol = ri(pRow + 1);
    var nEnemies = 1 + ri(2);
    var enemies = [];
    for (var k = 0; k < nEnemies; k++) {
        var t = types[ri(types.length)];
        var er, ec;
        if (t === 'egg') { er = 1 + ri(4); ec = ri(er + 1); }
        else if (t === 'ugg') { er = 2 + ri(5); ec = er; } // along right edge
        else { er = 2 + ri(5); ec = 0; } // wrongway left edge
        if (er === pRow && ec === pCol) continue; // skip collision
        enemies.push(mkEnemy(t, er, ec, ri(8)));
    }
    if (enemies.length === 0) continue;

    var gs = mkGs(pRow, pCol, enemies);
    var pathLists = [];
    for (var ei = 0; ei < enemies.length; ei++) {
        pathLists.push(buildEnemyPaths(enemies[ei], sm, maxFrames));
    }
    var react = findReactiveSurvival(gs, pathLists, null, 0, maxFrames, TEST_DEPTH);

    var trialMismatch = [];
    for (var di = 0; di < dirs.length; di++) {
        var dir = dirs[di];
        if (dir !== 'STAY') {
            var pd = DIRS[dir];
            if (!isValidPos(pRow + pd.dr, pCol + pd.dc)) continue;
        }
        total++;
        var brute = bruteTopLevel(gs, dir, TEST_DEPTH);
        var r = react[dir] !== undefined ? react[dir] : 0;
        var diff = r - brute;
        if (Math.abs(diff) >= 0.01) {
            if (diff > 0) dangerous++;
            trialMismatch.push({dir: dir, brute: brute, reactive: r, diff: diff});
        }
    }
    if (trialMismatch.length > 0) {
        var info = 'Trial ' + trial + ': p=(' + pRow + ',' + pCol + ') enemies=[';
        for (var k = 0; k < enemies.length; k++) {
            info += enemies[k].type + '@(' + enemies[k].row + ',' + enemies[k].col + ') mt=' + enemies[k].moveTimer;
            if (k < enemies.length - 1) info += ', ';
        }
        info += ']';
        mismatches.push({info: info, trialMismatch: trialMismatch});
    }
}

console.log('Total checks: ' + total + ', mismatches: ' + mismatches.reduce(function(s, m) { return s + m.trialMismatch.length; }, 0) + ', dangerous (reactive>brute): ' + dangerous);
for (var mi = 0; mi < mismatches.length; mi++) {
    console.log(mismatches[mi].info);
    for (var ti = 0; ti < mismatches[mi].trialMismatch.length; ti++) {
        var m = mismatches[mi].trialMismatch[ti];
        var tag = m.diff > 0 ? 'DANGEROUS' : 'conservative';
        console.log('  ' + m.dir + ': brute=' + m.brute.toFixed(3) + ' reactive=' + m.reactive.toFixed(3) + ' diff=' + m.diff.toFixed(3) + ' [' + tag + ']');
    }
}
