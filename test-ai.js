#!/usr/bin/env node
// Q*bert AI test harness — simulates full games and prints each move

// ─── Core constants ────────────────────────────────────────────────────────────
var ROWS = 7;
var DIRS = { UL: {dr:-1, dc:-1}, UR: {dr:-1, dc:0}, DL: {dr:1, dc:0}, DR: {dr:1, dc:1} };
var DIR_KEYS = ['UL', 'UR', 'DL', 'DR'];

// ─── Global game state ─────────────────────────────────────────────────────────
var player, enemies, cubeStates, discs, round, score;
var aiTour, aiTourIdx, aiBoardSig, aiDetailPath, aiTourDots, aiMoveTimer;

// ─── Board functions ───────────────────────────────────────────────────────────
function isValidPos(row, col) {
    return row >= 0 && row < ROWS && col >= 0 && col <= row;
}

function cubeAt(row, col) {
    if (!isValidPos(row, col)) return null;
    for (var i = 0; i < cubeStates.length; i++)
        if (cubeStates[i].row === row && cubeStates[i].col === col) return cubeStates[i];
    return null;
}

function targetState() { return round >= 5 ? 2 : 1; }

function allColored() {
    var tgt = targetState();
    for (var i = 0; i < cubeStates.length; i++)
        if (cubeStates[i].state < tgt) return false;
    return true;
}

function discRows() {
    var r = ((round - 1) % 5) + 1;
    if (r === 1) return [2, 3];
    if (r === 2) return [3, 2];
    if (r === 3) return [4, 3];
    if (r === 4) return [2, 4];
    return [3, 3];
}

function discCatchRow(side) { return discRows()[side]; }

// ─── BFS pathfinding ───────────────────────────────────────────────────────────
function bfsTo(r1, c1, r2, c2, avoidSet) {
    if (r1 === r2 && c1 === c2) return { dist: 0, path: [] };
    var visited = {}; visited[r1 + ',' + c1] = true;
    var queue = [{ row: r1, col: c1, path: [] }];
    while (queue.length > 0) {
        var cur = queue.shift();
        for (var k = 0; k < DIR_KEYS.length; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = cur.row + dk.dr, nc = cur.col + dk.dc;
            if (!isValidPos(nr, nc)) continue;
            var key = nr + ',' + nc;
            if (visited[key]) continue;
            if (avoidSet && avoidSet[key]) continue;
            visited[key] = true;
            var np = cur.path.concat([DIR_KEYS[k]]);
            if (nr === r2 && nc === c2) return { dist: np.length, path: np };
            queue.push({ row: nr, col: nc, path: np });
        }
    }
    return null;
}

// ─── Danger maps ───────────────────────────────────────────────────────────────
function predictCoilyPos(coily, targetRow, targetCol, steps) {
    var cr = coily.row, cc = coily.col;
    for (var s = 0; s < steps; s++) {
        var bestDir = null, bestDist = Infinity;
        for (var k = 0; k < DIR_KEYS.length; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = cr + dk.dr, nc = cc + dk.dc;
            if (!isValidPos(nr, nc)) continue;
            var dist = Math.abs(targetRow - nr) + Math.abs(targetCol - nc);
            if (dist < bestDist) { bestDist = dist; bestDir = k; }
        }
        if (bestDir === null) break;
        var dd = DIRS[DIR_KEYS[bestDir]];
        cr += dd.dr; cc += dd.dc;
    }
    return { row: cr, col: cc };
}

function buildDangerMaps() {
    var immediate = {}, predicted = {}, coilies = [];
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;
        if (e.type === 'greenball' || e.type === 'slick') continue;
        immediate[e.row + ',' + e.col] = true;
        for (var k = 0; k < DIR_KEYS.length; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = e.row + dk.dr, nc = e.col + dk.dc;
            if (isValidPos(nr, nc)) immediate[nr + ',' + nc] = true;
        }
        if (e.type === 'coily') coilies.push(e);
    }
    for (var ci = 0; ci < coilies.length; ci++) {
        for (var step = 1; step <= 3; step++) {
            var fp = predictCoilyPos(coilies[ci], player.row, player.col, step);
            predicted[fp.row + ',' + fp.col] = true;
            for (var k = 0; k < DIR_KEYS.length; k++) {
                var dk = DIRS[DIR_KEYS[k]];
                var nr = fp.row + dk.dr, nc = fp.col + dk.dc;
                if (isValidPos(nr, nc)) predicted[nr + ',' + nc] = true;
            }
        }
    }
    return { immediate: immediate, predicted: predicted, coilies: coilies };
}

function countEscapes(row, col, dangerSet) {
    var count = 0;
    for (var k = 0; k < DIR_KEYS.length; k++) {
        var dk = DIRS[DIR_KEYS[k]];
        var nr = row + dk.dr, nc = col + dk.dc;
        if (isValidPos(nr, nc) && !dangerSet[nr + ',' + nc]) count++;
    }
    return count;
}

function boardSig() {
    var s = '';
    for (var i = 0; i < cubeStates.length; i++) s += cubeStates[i].state;
    return s;
}

function buildTour() {
    var tgt = targetState();
    var danger = buildDangerMaps();
    var remaining = [];
    for (var i = 0; i < cubeStates.length; i++)
        if (cubeStates[i].state < tgt)
            remaining.push({ row: cubeStates[i].row, col: cubeStates[i].col });
    var tour = [];
    var cr = player.row, cc = player.col;
    while (remaining.length > 0) {
        var best = null, bestCost = Infinity, bestIdx = -1;
        for (var i = 0; i < remaining.length; i++) {
            var res = bfsTo(cr, cc, remaining[i].row, remaining[i].col);
            if (!res) continue;
            var cost = res.dist;
            if (danger.immediate[remaining[i].row + ',' + remaining[i].col]) cost += 8;
            if (danger.predicted[remaining[i].row + ',' + remaining[i].col]) cost += 3;
            var tr = remaining[i].row, tc2 = remaining[i].col;
            if (tr >= ROWS - 1 && (tc2 === 0 || tc2 === tr)) cost += 4;
            if (danger.coilies.length > 0 && countEscapes(tr, tc2, danger.immediate) <= 1) cost += 6;
            if (cost < bestCost) {
                bestCost = cost; best = remaining[i]; bestIdx = i;
            }
        }
        if (!best) break;
        tour.push(best);
        remaining.splice(bestIdx, 1);
        cr = best.row; cc = best.col;
    }
    aiTour = tour;
    aiTourIdx = 0;
    aiBoardSig = boardSig();
}

// ─── Expectimax ────────────────────────────────────────────────────────────────
var EXPECTIMAX_DEPTH = 4;

function exCubeAt(st, row, col) {
    for (var i = 0; i < st.cubes.length; i++)
        if (st.cubes[i].row === row && st.cubes[i].col === col) return st.cubes[i];
    return null;
}

function exCloneState() {
    var tgt = targetState();
    var cs = new Array(cubeStates.length);
    for (var i = 0; i < cubeStates.length; i++)
        cs[i] = { row: cubeStates[i].row, col: cubeStates[i].col, state: cubeStates[i].state };
    var det = [], stoch = [];
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;
        if (e.type === 'greenball' || e.type === 'slick') continue;
        var clone = { type: e.type, row: e.row, col: e.col, hops: e.hops || 0 };
        if (e.type === 'coily') det.push(clone);
        else stoch.push(clone);
    }
    var colored = 0;
    for (var i = 0; i < cs.length; i++) if (cs[i].state >= tgt) colored++;
    return { pr: player.row, pc: player.col, cubes: cs, det: det, stoch: stoch,
             alive: true, score: 0, cubesColored: colored, tgt: tgt };
}

function exClone(st) {
    var cs = new Array(st.cubes.length);
    for (var i = 0; i < st.cubes.length; i++)
        cs[i] = { row: st.cubes[i].row, col: st.cubes[i].col, state: st.cubes[i].state };
    var det = [];
    for (var i = 0; i < st.det.length; i++)
        det.push({ type: st.det[i].type, row: st.det[i].row, col: st.det[i].col, hops: st.det[i].hops });
    var stoch = [];
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
    if (st.cubesColored >= st.cubes.length) {
        st.score += 1000; st.det = []; st.stoch = []; return true;
    }
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
        if (bd !== null) {
            var dd = DIRS[DIR_KEYS[bd]];
            e.row += dd.dr; e.col += dd.dc;
        }
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
        if (!isValidPos(nr, nc)) {
            st.stoch.splice(i, 1);
            continue;
        }
        e.row = nr; e.col = nc;
        if (e.type === 'slick') {
            var sc = exCubeAt(st, nr, nc);
            if (sc && sc.state > 0) { sc.state--; st.cubesColored--; }
        }
        if (e.row === st.pr && e.col === st.pc) {
            if (e.type === 'slick') { st.score += 300; st.stoch.splice(i, 1); }
            else if (e.type === 'greenball') { st.score += 100; st.stoch.splice(i, 1); }
            else { st.alive = false; return; }
        }
    }
}

function exBfsDist(r1, c1, r2, c2) {
    if (r1 === r2 && c1 === c2) return 0;
    var visited = {}; visited[r1+','+c1] = true;
    var queue = [{r:r1, c:c1, d:0}];
    while (queue.length > 0) {
        var cur = queue.shift();
        for (var k = 0; k < 4; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = cur.r+dk.dr, nc = cur.c+dk.dc;
            if (!isValidPos(nr,nc)) continue;
            var key = nr+','+nc;
            if (visited[key]) continue;
            visited[key] = true;
            if (nr === r2 && nc === c2) return cur.d+1;
            queue.push({r:nr, c:nc, d:cur.d+1});
        }
    }
    return 99;
}

function exTourCost(st) {
    var remaining = [];
    for (var i = 0; i < st.cubes.length; i++)
        if (st.cubes[i].state < st.tgt)
            remaining.push(st.cubes[i]);
    if (remaining.length === 0) return 0;
    var totalDist = 0;
    var cr = st.pr, cc = st.pc;
    var used = new Array(remaining.length);
    for (var step = 0; step < remaining.length; step++) {
        var bestIdx = -1, bestDist = 99;
        for (var j = 0; j < remaining.length; j++) {
            if (used[j]) continue;
            var d = exBfsDist(cr, cc, remaining[j].row, remaining[j].col);
            if (d < bestDist) { bestDist = d; bestIdx = j; }
        }
        if (bestIdx < 0) break;
        used[bestIdx] = true;
        totalDist += bestDist;
        cr = remaining[bestIdx].row; cc = remaining[bestIdx].col;
    }
    return totalDist;
}

function exLeafValue(st) {
    if (!st.alive) return -5000;
    if (st.cubesColored >= st.cubes.length) return 50000;
    var tourCost = exTourCost(st);
    return st.cubesColored * 100 + st.score * 0.3 + 200 - tourCost * 10;
}

function expectimax(st, depth) {
    if (!st.alive) return -5000;
    if (depth === 0) return exLeafValue(st);
    var bestVal = -Infinity;
    for (var k = 0; k < 4; k++) {
        var dk = DIRS[DIR_KEYS[k]];
        if (!isValidPos(st.pr + dk.dr, st.pc + dk.dc)) continue;
        var child = exClone(st);
        if (!exPlayerMove(child, DIR_KEYS[k])) {
            if (-5000 > bestVal) bestVal = -5000;
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
        if (total > bestVal) bestVal = total;
    }
    return bestVal;
}

function expectimaxEval(dirKey) {
    var st = exCloneState();
    if (!exPlayerMove(st, dirKey)) return -5000;
    var numStoch = Math.min(st.stoch.length, 5);
    var depth = numStoch <= 1 ? 4 : numStoch <= 2 ? 3 : 2;
    var numOutcomes = 1 << numStoch;
    var prob = 1.0 / numOutcomes;
    var total = 0;
    for (var out = 0; out < numOutcomes; out++) {
        var branch = exClone(st);
        exApplyStochastic(branch, out);
        total += expectimax(branch, depth - 1) * prob;
    }
    return total + exLeafValue(st) * 0.0001;
}

function computeAIMove() {
    var tgt = targetState();
    var danger = buildDangerMaps();

    // Disc escape override
    var coilyDist = 999;
    for (var i = 0; i < danger.coilies.length; i++) {
        var c = danger.coilies[i];
        var d = Math.abs(c.row - player.row) + Math.abs(c.col - player.col);
        if (d < coilyDist) coilyDist = d;
    }
    var shouldEscape = coilyDist <= 3;
    var safeMoveCount = countEscapes(player.row, player.col, danger.immediate);
    if (safeMoveCount <= 1 && coilyDist <= 4) shouldEscape = true;
    if (shouldEscape) {
        var lDiscRow = discCatchRow(0), rDiscRow = discCatchRow(1);
        if (discs[0].active && player.col === 0 && player.row === lDiscRow) return 'UL';
        if (discs[1].active && player.col === player.row && player.row === rDiscRow) return 'UR';
        if (coilyDist <= 2) {
            if (discs[0].active) {
                var ulD = DIRS['UL'];
                var ulR = player.row + ulD.dr, ulC = player.col + ulD.dc;
                if (isValidPos(ulR, ulC) && ulC === 0 && ulR === lDiscRow && !danger.immediate[ulR + ',' + ulC]) return 'UL';
                var dlD = DIRS['DL'];
                var dlR = player.row + dlD.dr, dlC = player.col + dlD.dc;
                if (isValidPos(dlR, dlC) && dlC === 0 && dlR === lDiscRow && !danger.immediate[dlR + ',' + dlC]) return 'DL';
            }
            if (discs[1].active) {
                var urD = DIRS['UR'];
                var urR = player.row + urD.dr, urC = player.col + urD.dc;
                if (isValidPos(urR, urC) && urC === urR && urR === rDiscRow && !danger.immediate[urR + ',' + urC]) return 'UR';
                var drD = DIRS['DR'];
                var drR = player.row + drD.dr, drC = player.col + drD.dc;
                if (isValidPos(drR, drC) && drC === drR && drR === rDiscRow && !danger.immediate[drR + ',' + drC]) return 'DR';
            }
        }
    }

    // Expectimax
    var bestDir = null, bestVal = -Infinity;
    for (var k = 0; k < 4; k++) {
        var dk = DIRS[DIR_KEYS[k]];
        if (!isValidPos(player.row + dk.dr, player.col + dk.dc)) continue;
        var val = expectimaxEval(DIR_KEYS[k]);
        if (val > bestVal) {
            bestVal = val;
            bestDir = DIR_KEYS[k];
        }
    }

    // Tour viz (not needed for logic, but keep for parity)
    if (boardSig() !== aiBoardSig || aiTour.length === 0) buildTour();

    return bestDir || 'DL';
}

// ─── Game simulation ───────────────────────────────────────────────────────────
function initRound() {
    cubeStates = [];
    for (var r = 0; r < ROWS; r++)
        for (var c = 0; c <= r; c++)
            cubeStates.push({ row: r, col: c, state: 0 });

    player = { row: 0, col: 0 };
    // Color starting cube
    var cube = cubeAt(0, 0);
    if (cube) cube.state = Math.min(cube.state + 1, targetState());

    discs = [{ side: 0, active: true }, { side: 1, active: true }];
    enemies = [];
    aiTour = []; aiTourIdx = 0; aiBoardSig = ''; aiDetailPath = []; aiTourDots = [];
}

function stompCube(row, col) {
    var cube = cubeAt(row, col);
    if (!cube) return;
    var tgt = targetState();
    if (cube.state < tgt) {
        cube.state++;
        score += 25;
    }
}

function moveEnemies() {
    // Process spawn timers
    for (var i = enemies.length - 1; i >= 0; i--) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') {
            e.timer--;
            if (e.timer <= 0) {
                var ft = e.forcedType;
                enemies.splice(i, 1);
                spawnEnemy(ft);
            }
        }
    }

    // Move actual enemies
    for (var i = enemies.length - 1; i >= 0; i--) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;

        if (e.type === 'egg') {
            var dir = Math.random() < 0.5 ? 'DL' : 'DR';
            var delta = DIRS[dir];
            var nr = e.row + delta.dr, nc = e.col + delta.dc;
            if (isValidPos(nr, nc)) {
                e.row = nr; e.col = nc;
                e.hops++;
                if (e.hops >= 6 || nr >= ROWS - 1) e.type = 'coily';
            } else {
                e.type = 'coily';
            }
        } else if (e.type === 'coily') {
            var bestDir = null, bestDist = Infinity;
            for (var k = 0; k < DIR_KEYS.length; k++) {
                var dk = DIRS[DIR_KEYS[k]];
                var enr = e.row + dk.dr, enc = e.col + dk.dc;
                if (!isValidPos(enr, enc)) continue;
                var dist = Math.abs(player.row - enr) + Math.abs(player.col - enc);
                if (dist < bestDist) { bestDist = dist; bestDir = { nr: enr, nc: enc }; }
            }
            if (bestDir) { e.row = bestDir.nr; e.col = bestDir.nc; }
            else { enemies.splice(i, 1); scheduleSpawn(5); }
        } else if (e.type === 'redball') {
            var rbdir = Math.random() < 0.5 ? 'DL' : 'DR';
            var rbdelta = DIRS[rbdir];
            var rbnr = e.row + rbdelta.dr, rbnc = e.col + rbdelta.dc;
            if (isValidPos(rbnr, rbnc)) { e.row = rbnr; e.col = rbnc; }
            else { enemies.splice(i, 1); scheduleSpawn(5, 'redball'); }
        } else if (e.type === 'greenball') {
            var gbdir = Math.random() < 0.5 ? 'DL' : 'DR';
            var gbdelta = DIRS[gbdir];
            var gbnr = e.row + gbdelta.dr, gbnc = e.col + gbdelta.dc;
            if (isValidPos(gbnr, gbnc)) { e.row = gbnr; e.col = gbnc; }
            else { enemies.splice(i, 1); }
        } else if (e.type === 'slick') {
            var sdir = Math.random() < 0.5 ? 'DL' : 'DR';
            var sdelta = DIRS[sdir];
            var snr = e.row + sdelta.dr, snc = e.col + sdelta.dc;
            if (isValidPos(snr, snc)) {
                e.row = snr; e.col = snc;
                var sc = cubeAt(snr, snc);
                if (sc && sc.state > 0) sc.state--;
            } else { enemies.splice(i, 1); }
        }
    }
}

function spawnEnemy(forcedType) {
    var type = forcedType;
    if (!type) {
        var hasCoily = false;
        for (var i = 0; i < enemies.length; i++)
            if (enemies[i].type === 'coily' || enemies[i].type === 'egg') { hasCoily = true; break; }
        type = hasCoily ? 'redball' : 'egg';
    }
    var spawnRow = (type === 'redball' || type === 'greenball') ? 1 : 0;
    var spawnCol = (type === 'redball' || type === 'greenball') ? Math.floor(Math.random() * 2) : 0;
    if (type === 'egg') {
        enemies.push({ type: 'egg', row: 0, col: 0, hops: 0 });
    } else {
        enemies.push({ type: type, row: spawnRow, col: spawnCol, hops: 0 });
    }
}

function scheduleSpawn(delay, forcedType) {
    enemies.push({ type: 'spawn-timer', timer: delay, forcedType: forcedType || null });
}

function checkCollision() {
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;
        if (e.row === player.row && e.col === player.col) {
            if (e.type === 'slick') { score += 300; enemies.splice(i, 1); i--; }
            else if (e.type === 'greenball') { score += 100; enemies.splice(i, 1); i--; }
            else return true; // dead
        }
    }
    return false;
}

// ─── Visualization ─────────────────────────────────────────────────────────────
function drawBoard() {
    var tgt = targetState();
    var grid = {};
    for (var i = 0; i < cubeStates.length; i++) {
        var c = cubeStates[i];
        grid[c.row + ',' + c.col] = c.state >= tgt ? '#' : '.';
    }
    // Mark enemies
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;
        var k = e.row + ',' + e.col;
        if (e.type === 'coily') grid[k] = 'C';
        else if (e.type === 'egg') grid[k] = 'E';
        else if (e.type === 'redball') grid[k] = 'R';
        else if (e.type === 'greenball') grid[k] = 'G';
        else if (e.type === 'slick') grid[k] = 'S';
    }
    // Mark player (overwrites)
    grid[player.row + ',' + player.col] = '@';

    var lines = [];
    for (var r = 0; r < ROWS; r++) {
        var pad = '';
        for (var p = 0; p < ROWS - 1 - r; p++) pad += ' ';
        var row = '';
        for (var c = 0; c <= r; c++) {
            var ch = grid[r + ',' + c] || '?';
            row += ch + ' ';
        }
        lines.push(pad + row.trim());
    }
    return lines.join('\n');
}

function countRemaining() {
    var tgt = targetState();
    var n = 0;
    for (var i = 0; i < cubeStates.length; i++)
        if (cubeStates[i].state < tgt) n++;
    return n;
}

function enemySummary() {
    var parts = [];
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') { parts.push('spawn(' + e.timer + ')'); continue; }
        parts.push(e.type + '@(' + e.row + ',' + e.col + ')');
    }
    return parts.length ? parts.join(' ') : 'none';
}

// ─── Run simulation ────────────────────────────────────────────────────────────
function runGame(maxRounds, verbose) {
    round = 1;
    score = 0;
    var lives = 3;
    var totalDeaths = 0;

    for (; round <= maxRounds; round++) {
        initRound();
        var moveNum = 0;
        var maxMoves = 200;
        var stuck = 0;
        var lastSig = '';

        if (verbose) {
            console.log('\n' + '='.repeat(50));
            console.log('ROUND ' + round + ' (target: ' + targetState() + ')');
            console.log('='.repeat(50));
        }

        while (!allColored() && moveNum < maxMoves) {
            moveNum++;

            // Get AI move
            var move = computeAIMove();
            var oldRow = player.row, oldCol = player.col;

            // Apply player move
            var d = DIRS[move];
            var nr = player.row + d.dr, nc = player.col + d.dc;
            if (!isValidPos(nr, nc)) {
                if (verbose) console.log('  Move ' + moveNum + ': ' + move + ' -> OFF BOARD! Death.');
                lives--; totalDeaths++;
                if (lives <= 0) {
                    console.log('GAME OVER at round ' + round + ', score=' + score);
                    return { rounds: round, score: score, deaths: totalDeaths };
                }
                // Reset player to (0,0)
                player.row = 0; player.col = 0;
                continue;
            }
            player.row = nr; player.col = nc;
            stompCube(nr, nc);

            // Check collision before enemy moves
            if (checkCollision()) {
                if (verbose) console.log('  Move ' + moveNum + ': ' + move + ' (' + oldRow + ',' + oldCol + ')->(' + nr + ',' + nc + ') DIED (walked into enemy)');
                lives--; totalDeaths++;
                if (lives <= 0) {
                    console.log('GAME OVER at round ' + round + ', score=' + score);
                    return { rounds: round, score: score, deaths: totalDeaths };
                }
                player.row = 0; player.col = 0;
                continue;
            }

            // Move enemies
            moveEnemies();

            // Check collision after enemy moves
            if (checkCollision()) {
                if (verbose) console.log('  Move ' + moveNum + ': ' + move + ' (' + oldRow + ',' + oldCol + ')->(' + nr + ',' + nc + ') DIED (enemy moved onto player)');
                lives--; totalDeaths++;
                if (lives <= 0) {
                    console.log('GAME OVER at round ' + round + ', score=' + score);
                    return { rounds: round, score: score, deaths: totalDeaths };
                }
                player.row = 0; player.col = 0;
                continue;
            }

            // Detect oscillation
            var sig = player.row + ',' + player.col + '|' + boardSig();
            if (sig === lastSig) stuck++;
            else { stuck = 0; lastSig = sig; }

            if (verbose) {
                var remaining = countRemaining();
                console.log('  Move ' + moveNum + ': ' + move + ' (' + oldRow + ',' + oldCol + ')->(' + nr + ',' + nc + ')  remaining=' + remaining + '  enemies: ' + enemySummary());
                if (stuck >= 2 || moveNum % 10 === 0) {
                    console.log(drawBoard());
                }
                if (stuck >= 4) {
                    console.log('  *** OSCILLATING! Stuck for ' + stuck + ' moves ***');
                }
            }

            if (stuck >= 10) {
                console.log('  STUCK: oscillating for 10+ moves, aborting round');
                break;
            }
        }

        if (allColored()) {
            score += 1000;
            if (verbose) console.log('  Round ' + round + ' COMPLETE in ' + moveNum + ' moves! Score=' + score);
            else console.log('Round ' + round + ' done in ' + moveNum + ' moves, deaths=' + totalDeaths + ', score=' + score);
        } else {
            console.log('  Round ' + round + ' FAILED after ' + moveNum + ' moves');
        }
    }

    return { rounds: maxRounds, score: score, deaths: totalDeaths };
}

// ─── Main ──────────────────────────────────────────────────────────────────────
var verbose = process.argv.includes('-v') || process.argv.includes('--verbose');
var numRounds = 5;
for (var i = 2; i < process.argv.length; i++) {
    var n = parseInt(process.argv[i]);
    if (!isNaN(n) && n > 0) { numRounds = n; break; }
}

console.log('Running ' + numRounds + ' rounds' + (verbose ? ' (verbose)' : '') + '...\n');
var result = runGame(numRounds, verbose);
console.log('\nFinal: rounds=' + result.rounds + ' score=' + result.score + ' deaths=' + result.deaths);
