#!/usr/bin/env node
// Debug: reproduce the exact oscillation scenario and print expectimax values

var ROWS = 7;
var DIRS = { UL: {dr:-1, dc:-1}, UR: {dr:-1, dc:0}, DL: {dr:1, dc:0}, DR: {dr:1, dc:1} };
var DIR_KEYS = ['UL', 'UR', 'DL', 'DR'];
var player, enemies, cubeStates, discs, round, score;

function isValidPos(row, col) { return row >= 0 && row < ROWS && col >= 0 && col <= row; }
function cubeAt(row, col) {
    for (var i = 0; i < cubeStates.length; i++)
        if (cubeStates[i].row === row && cubeStates[i].col === col) return cubeStates[i];
    return null;
}
function targetState() { return round >= 5 ? 2 : 1; }

var EXPECTIMAX_DEPTH = 4;

function exCubeAt(st, row, col) {
    for (var i = 0; i < st.cubes.length; i++)
        if (st.cubes[i].row === row && st.cubes[i].col === col) return st.cubes[i];
    return null;
}

function exCloneState() {
    var tgt = targetState();
    var cs = [];
    for (var i = 0; i < cubeStates.length; i++)
        cs.push({ row: cubeStates[i].row, col: cubeStates[i].col, state: cubeStates[i].state });
    var det = [], stoch = [];
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer' || e.type === 'greenball' || e.type === 'slick') continue;
        var clone = { type: e.type, row: e.row, col: e.col, hops: e.hops || 0 };
        if (e.type === 'coily') det.push(clone); else stoch.push(clone);
    }
    var colored = 0;
    for (var i = 0; i < cs.length; i++) if (cs[i].state >= tgt) colored++;
    return { pr: player.row, pc: player.col, cubes: cs, det: det, stoch: stoch,
             alive: true, score: 0, cubesColored: colored, tgt: tgt };
}

function exClone(st) {
    var cs = [];
    for (var i = 0; i < st.cubes.length; i++)
        cs.push({ row: st.cubes[i].row, col: st.cubes[i].col, state: st.cubes[i].state });
    var det = [], stoch = [];
    for (var i = 0; i < st.det.length; i++)
        det.push({ type: st.det[i].type, row: st.det[i].row, col: st.det[i].col, hops: st.det[i].hops });
    for (var i = 0; i < st.stoch.length; i++)
        stoch.push({ type: st.stoch[i].type, row: st.stoch[i].row, col: st.stoch[i].col, hops: st.stoch[i].hops });
    return { pr: st.pr, pc: st.pc, cubes: cs, det: det, stoch: stoch,
             alive: st.alive, score: st.score, cubesColored: st.cubesColored, tgt: st.tgt };
}

function exPlayerMove(st, dirKey) {
    if (!st.alive) return false;
    var d = DIRS[dirKey];
    var nr = st.pr + d.dr, nc = st.pc + d.dc;
    if (!isValidPos(nr, nc)) { st.alive = false; return false; }
    st.pr = nr; st.pc = nc;
    var cube = exCubeAt(st, nr, nc);
    if (cube && cube.state < st.tgt) { cube.state++; st.score += 25; st.cubesColored++; }
    if (st.cubesColored >= st.cubes.length) { st.score += 1000; st.det = []; st.stoch = []; return true; }
    var allEnemies = st.det.concat(st.stoch);
    for (var i = 0; i < allEnemies.length; i++) {
        var e = allEnemies[i];
        if (e.row === nr && e.col === nc) {
            if (e.type === 'slick') { st.score += 300; }
            else if (e.type === 'greenball') { st.score += 100; }
            else { st.alive = false; return false; }
        }
    }
    for (var i = 0; i < st.det.length; i++) {
        var e = st.det[i];
        var bd = null, bv = Infinity;
        for (var k = 0; k < 4; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var er = e.row + dk.dr, ec = e.col + dk.dc;
            if (!isValidPos(er, ec)) continue;
            var dv = Math.abs(st.pr - er) + Math.abs(st.pc - ec);
            if (dv < bv) { bv = dv; bd = k; }
        }
        if (bd !== null) { var dd = DIRS[DIR_KEYS[bd]]; e.row += dd.dr; e.col += dd.dc; }
        if (e.row === st.pr && e.col === st.pc) { st.alive = false; return false; }
    }
    return true;
}

function exApplyStochastic(st, outcomes) {
    for (var i = st.stoch.length - 1; i >= 0; i--) {
        var e = st.stoch[i];
        var dir = (outcomes >> i) & 1 ? 'DR' : 'DL';
        var d = DIRS[dir];
        var nr = e.row + d.dr, nc = e.col + d.dc;
        if (!isValidPos(nr, nc)) { st.stoch.splice(i, 1); continue; }
        e.row = nr; e.col = nc;
        if (e.row === st.pr && e.col === st.pc) {
            if (e.type === 'slick' || e.type === 'greenball') { st.stoch.splice(i, 1); }
            else { st.alive = false; return; }
        }
    }
}

function exLeafValue(st) {
    if (!st.alive) return -5000;
    if (st.cubesColored >= st.cubes.length) return 50000;
    var nearDist = 99;
    var visited = {}; visited[st.pr+','+st.pc] = true;
    var queue = [{r:st.pr, c:st.pc, d:0}];
    while (queue.length > 0) {
        var cur = queue.shift();
        var cb = exCubeAt(st, cur.r, cur.c);
        if (cb && cb.state < st.tgt) { nearDist = cur.d; break; }
        for (var k = 0; k < 4; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = cur.r+dk.dr, nc = cur.c+dk.dc;
            if (!isValidPos(nr,nc)) continue;
            var key = nr+','+nc;
            if (visited[key]) continue;
            visited[key] = true;
            queue.push({r:nr, c:nc, d:cur.d+1});
        }
    }
    return st.cubesColored * 100 + st.score * 0.3 + 200 - nearDist * 15;
}

function expectimax(st, depth, trace) {
    if (!st.alive) return -5000;
    if (depth === 0) return exLeafValue(st);
    var bestVal = -Infinity, bestDir = null;
    for (var k = 0; k < 4; k++) {
        var dk = DIRS[DIR_KEYS[k]];
        if (!isValidPos(st.pr + dk.dr, st.pc + dk.dc)) continue;
        var child = exClone(st);
        if (!exPlayerMove(child, DIR_KEYS[k])) {
            if (-5000 > bestVal) { bestVal = -5000; bestDir = DIR_KEYS[k]; }
            continue;
        }
        var numStoch = Math.min(child.stoch.length, 5);
        var numOutcomes = 1 << numStoch;
        var prob = 1.0 / numOutcomes;
        var total = 0;
        for (var out = 0; out < numOutcomes; out++) {
            var branch = exClone(child);
            exApplyStochastic(branch, out);
            total += expectimax(branch, depth - 1) * prob;
        }
        if (trace) console.log('    depth=' + depth + ' dir=' + DIR_KEYS[k] + ' val=' + total.toFixed(1) + ' pos=(' + (st.pr+dk.dr) + ',' + (st.pc+dk.dc) + ') colored=' + child.cubesColored);
        if (total > bestVal) { bestVal = total; bestDir = DIR_KEYS[k]; }
    }
    return bestVal;
}

// ─── Set up the exact oscillation scenario ─────────────────────────────────────
round = 1;
score = 0;
enemies = [];
discs = [{ side: 0, active: true }, { side: 1, active: true }];

// All cubes colored except (6,0)
cubeStates = [];
for (var r = 0; r < ROWS; r++)
    for (var c = 0; c <= r; c++)
        cubeStates.push({ row: r, col: c, state: (r === 6 && c === 0) ? 0 : 1 });

// Player at (4,0) — the oscillation position
player = { row: 4, col: 0 };

console.log('Scenario: player at (4,0), only (6,0) uncolored, no enemies');
console.log('Target state:', targetState());
console.log('Colored count:', cubeStates.filter(c => c.state >= targetState()).length, '/', cubeStates.length);
console.log('');

// Show what exLeafValue thinks about each immediate position
console.log('Leaf values from (4,0):');
for (var k = 0; k < 4; k++) {
    var dk = DIRS[DIR_KEYS[k]];
    var nr = 4 + dk.dr, nc = 0 + dk.dc;
    if (!isValidPos(nr, nc)) { console.log('  ' + DIR_KEYS[k] + ': invalid'); continue; }
    // Simulate stepping there
    var st = exCloneState();
    exPlayerMove(st, DIR_KEYS[k]);
    var leaf = exLeafValue(st);
    console.log('  ' + DIR_KEYS[k] + ' -> (' + nr + ',' + nc + '): leaf=' + leaf.toFixed(1) + ' colored=' + st.cubesColored + ' score=' + st.score);
}

console.log('');
console.log('Expectimax from (4,0) with depth 4:');
var st = exCloneState();
for (var k = 0; k < 4; k++) {
    var dk = DIRS[DIR_KEYS[k]];
    if (!isValidPos(4 + dk.dr, 0 + dk.dc)) { console.log('  ' + DIR_KEYS[k] + ': invalid'); continue; }
    var child = exClone(st);
    exPlayerMove(child, DIR_KEYS[k]);
    var val = expectimax(child, 3, false);
    console.log('  ' + DIR_KEYS[k] + ' -> (' + (4+dk.dr) + ',' + (0+dk.dc) + '): val=' + val.toFixed(1));
}

console.log('');
console.log('Tracing DL (toward uncolored) vs UR (away) at depth 4:');
console.log('--- DL trace ---');
var stDL = exClone(st);
exPlayerMove(stDL, 'DL');
console.log('  After DL: pos=(' + stDL.pr + ',' + stDL.pc + ') colored=' + stDL.cubesColored);
var valDL = expectimax(stDL, 3, true);
console.log('  DL total: ' + valDL.toFixed(1));

console.log('--- UR trace ---');
var stUR = exClone(st);
exPlayerMove(stUR, 'UR');
console.log('  After UR: pos=(' + stUR.pr + ',' + stUR.pc + ') colored=' + stUR.cubesColored);
var valUR = expectimax(stUR, 3, true);
console.log('  UR total: ' + valUR.toFixed(1));
