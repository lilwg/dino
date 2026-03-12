#!/usr/bin/env node
// Q*bert AI test harness — turn-based simulation (matches original arcade logic)
// Each turn: player hops, then all enemies hop once, collisions checked.

// ─── Core constants ────────────────────────────────────────────────────────────
var ROWS = 7;
var DIRS = { UL: {dr:-1, dc:-1}, UR: {dr:-1, dc:0}, DL: {dr:1, dc:0}, DR: {dr:1, dc:1} };
var DIR_KEYS = ['UL', 'UR', 'DL', 'DR'];

// ─── Global game state ─────────────────────────────────────────────────────────
var player, enemies, cubeStates, discs, round, score;
var aiTour, aiTourIdx, aiBoardSig, aiDetailPath, aiTourDots;

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

// ─── Expectimax with per-enemy move countdowns ────────────────────────────────
// Each turn = one player hop. Enemies move only when their countdown reaches 0.
// Countdown values derived from real-time intervals / player hop frames (~8).
var EX_HOPS_PER_MOVE = {
    egg:   4,   // 35 frames / 8 ≈ 4 player hops
    coily: 4,   // 28 frames / 8 ≈ 4 player hops
    redball: 4  // 30 frames / 8 ≈ 4 player hops
};

// Precompute all pairwise BFS distances
var bfsDistTable = {};
(function buildDistTable() {
    var positions = [];
    for (var r = 0; r < ROWS; r++)
        for (var c = 0; c <= r; c++)
            positions.push({ r: r, c: c });
    for (var i = 0; i < positions.length; i++) {
        var src = positions[i];
        var key0 = src.r + ',' + src.c;
        var dist = {}; dist[key0] = 0;
        var queue = [src];
        while (queue.length > 0) {
            var cur = queue.shift();
            var cd = dist[cur.r + ',' + cur.c];
            for (var k = 0; k < 4; k++) {
                var dk = DIRS[DIR_KEYS[k]];
                var nr = cur.r + dk.dr, nc = cur.c + dk.dc;
                if (!isValidPos(nr, nc)) continue;
                var nk = nr + ',' + nc;
                if (dist[nk] !== undefined) continue;
                dist[nk] = cd + 1;
                queue.push({ r: nr, c: nc });
            }
        }
        bfsDistTable[key0] = dist;
    }
})();

function exBfsDist(r1, c1, r2, c2) {
    var d = bfsDistTable[r1 + ',' + c1];
    return d ? (d[r2 + ',' + c2] || 99) : 99;
}

function exCubeAt(st, row, col) {
    for (var i = 0; i < st.cubes.length; i++)
        if (st.cubes[i].row === row && st.cubes[i].col === col) return st.cubes[i];
    return null;
}

// Clone real game state into expectimax state — with per-enemy countdowns
function exCloneState() {
    var tgt = targetState();
    var cs = new Array(cubeStates.length);
    for (var i = 0; i < cubeStates.length; i++)
        cs[i] = { row: cubeStates[i].row, col: cubeStates[i].col, state: cubeStates[i].state };
    var ens = [];
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;
        if (e.type === 'greenball' || e.type === 'slick') continue;
        var interval = EX_HOPS_PER_MOVE[e.type] || 4;
        var cd = e.moveCountdown !== undefined ? e.moveCountdown : interval;
        ens.push({ type: e.type, row: e.row, col: e.col, hops: e.hops || 0, countdown: cd });
    }
    var colored = 0;
    for (var i = 0; i < cs.length; i++) colored += Math.min(cs[i].state, tgt);
    return { pr: player.row, pc: player.col, cubes: cs, enemies: ens,
             alive: true, score: 0, cubesColored: colored, tgt: tgt,
             discs: [discs[0].active, discs[1].active],
             discRows: [discCatchRow(0), discCatchRow(1)] };
}

function exClone(st) {
    var cs = new Array(st.cubes.length);
    for (var i = 0; i < st.cubes.length; i++)
        cs[i] = { row: st.cubes[i].row, col: st.cubes[i].col, state: st.cubes[i].state };
    var ens = [];
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        ens.push({ type: e.type, row: e.row, col: e.col, hops: e.hops, countdown: e.countdown });
    }
    return { pr: st.pr, pc: st.pc, cubes: cs, enemies: ens,
             alive: st.alive, score: st.score, cubesColored: st.cubesColored, tgt: st.tgt,
             discs: [st.discs[0], st.discs[1]], discRows: st.discRows };
}

// Move enemies whose countdown reaches 0. stochOutcome: bit field for random directions
function exMoveEnemies(st, stochOutcome) {
    var stochBit = 0;
    for (var i = st.enemies.length - 1; i >= 0; i--) {
        var e = st.enemies[i];
        // Tick countdown — only move when it reaches 0
        e.countdown--;
        if (e.countdown > 0) continue;
        e.countdown = EX_HOPS_PER_MOVE[e.type] || 4;
        if (e.type === 'coily') {
            var bestDir = null, bestDist = Infinity;
            for (var k = 0; k < 4; k++) {
                var dk = DIRS[DIR_KEYS[k]];
                var er = e.row + dk.dr, ec = e.col + dk.dc;
                if (!isValidPos(er, ec)) continue;
                var dist = Math.abs(st.pr - er) + Math.abs(st.pc - ec);
                if (dist < bestDist) { bestDist = dist; bestDir = k; }
            }
            if (bestDir !== null) {
                var dd = DIRS[DIR_KEYS[bestDir]];
                e.row += dd.dr; e.col += dd.dc;
            }
        } else if (e.type === 'egg') {
            var dir = ((stochOutcome >> stochBit) & 1) ? 'DR' : 'DL';
            stochBit++;
            var dd = DIRS[dir];
            var nr = e.row + dd.dr, nc = e.col + dd.dc;
            if (isValidPos(nr, nc)) {
                e.row = nr; e.col = nc;
                e.hops++;
                if (e.hops >= 6 || nr >= ROWS - 1) {
                    e.type = 'coily';
                }
            } else {
                e.type = 'coily';
            }
        } else if (e.type === 'redball') {
            var dir = ((stochOutcome >> stochBit) & 1) ? 'DR' : 'DL';
            stochBit++;
            var dd = DIRS[dir];
            var nr = e.row + dd.dr, nc = e.col + dd.dc;
            if (isValidPos(nr, nc)) {
                e.row = nr; e.col = nc;
            } else {
                st.enemies.splice(i, 1);
            }
        }
    }
    // Check collisions after all enemies move
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        if (e.row === st.pr && e.col === st.pc) {
            if (e.type === 'coily' || e.type === 'redball' || e.type === 'egg') {
                st.alive = false; return;
            }
        }
    }
}

// Execute one turn: player moves, then enemies with expired countdowns move
function exPlayerMove(st, dirKey, stochOutcome) {
    if (!st.alive) return false;
    var d = DIRS[dirKey];
    var nr = st.pr + d.dr, nc = st.pc + d.dc;
    if (!isValidPos(nr, nc)) {
        if (dirKey === 'UL' && st.discs[0] && st.pc === 0 && st.pr === st.discRows[0]) {
            st.discs[0] = false;
            st.score += 600;
            for (var i = st.enemies.length - 1; i >= 0; i--) {
                if (st.enemies[i].type === 'coily' || st.enemies[i].type === 'egg') {
                    st.score += 300;
                    st.enemies.splice(i, 1);
                }
            }
            st.pr = 0; st.pc = 0;
            return true;
        }
        if (dirKey === 'UR' && st.discs[1] && st.pc === st.pr && st.pr === st.discRows[1]) {
            st.discs[1] = false;
            st.score += 600;
            for (var i = st.enemies.length - 1; i >= 0; i--) {
                if (st.enemies[i].type === 'coily' || st.enemies[i].type === 'egg') {
                    st.score += 300;
                    st.enemies.splice(i, 1);
                }
            }
            st.pr = 0; st.pc = 0;
            return true;
        }
        st.alive = false; return false;
    }
    st.pr = nr; st.pc = nc;
    var cube = exCubeAt(st, nr, nc);
    if (cube && cube.state < st.tgt) { cube.state++; st.score += 25; st.cubesColored++; }
    if (st.cubesColored >= st.cubes.length * st.tgt) {
        st.score += 1000; st.enemies = []; return true;
    }
    // Check collision with enemies at landing position
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        if (e.row === nr && e.col === nc) {
            if (e.type === 'coily' || e.type === 'redball' || e.type === 'egg') {
                st.alive = false; return false;
            }
        }
    }
    // Enemies with expired countdowns move
    exMoveEnemies(st, stochOutcome);
    return st.alive;
}

// Count stochastic enemies that will move this turn (countdown == 1, about to tick to 0)
function exCountStoch(st) {
    var count = 0;
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        if ((e.type === 'egg' || e.type === 'redball') && e.countdown <= 1) count++;
    }
    return Math.min(count, 5);
}

function exTourCost(st) {
    var remaining = [];
    for (var i = 0; i < st.cubes.length; i++) {
        var hitsNeeded = st.tgt - st.cubes[i].state;
        for (var h = 0; h < hitsNeeded; h++)
            remaining.push(st.cubes[i]);
    }
    if (remaining.length === 0) return 0;
    var totalDist = 0;
    var cr = st.pr, cc = st.pc;
    var used = new Array(remaining.length);
    for (var step = 0; step < remaining.length; step++) {
        var bestIdx = -1, bestDist = 99;
        for (var j = 0; j < remaining.length; j++) {
            if (used[j]) continue;
            var d = exBfsDist(cr, cc, remaining[j].row, remaining[j].col);
            if (d === 0) d = 2; // must leave and return to re-hit same cube
            if (d < bestDist) { bestDist = d; bestIdx = j; }
        }
        if (bestIdx < 0) break;
        used[bestIdx] = true;
        totalDist += bestDist;
        cr = remaining[bestIdx].row; cc = remaining[bestIdx].col;
    }
    return totalDist;
}

// State hash for memoization — includes countdown for timing-aware search
function exStateKey(st, depth) {
    var k = st.pr + ',' + st.pc + '|';
    for (var i = 0; i < st.cubes.length; i++) k += st.cubes[i].state;
    k += '|';
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        k += e.type[0] + e.row + ',' + e.col + 'c' + e.countdown + ';';
    }
    k += '|' + depth + '|' + (st.discs[0] ? 1 : 0) + (st.discs[1] ? 1 : 0);
    return k;
}

var exMemoTable = {};

var EX_DEATH = -50000;
var EX_WIN   =  50000;

function exLeafValue(st) {
    if (!st.alive) return EX_DEATH;
    if (st.cubesColored >= st.cubes.length * st.tgt) return EX_WIN;
    var tourCost = exTourCost(st);
    return st.cubesColored * 100 - tourCost * 10;
}

function exCanMove(st, dirKey) {
    var d = DIRS[dirKey];
    var nr = st.pr + d.dr, nc = st.pc + d.dc;
    if (isValidPos(nr, nc)) return true;
    if (dirKey === 'UL' && st.discs[0] && st.pc === 0 && st.pr === st.discRows[0]) return true;
    if (dirKey === 'UR' && st.discs[1] && st.pc === st.pr && st.pr === st.discRows[1]) return true;
    return false;
}

function expectimax(st, depth) {
    if (!st.alive) return EX_DEATH;
    if (st.cubesColored >= st.cubes.length * st.tgt) return EX_WIN + depth * 100;
    if (depth === 0) return exLeafValue(st);

    var key = exStateKey(st, depth);
    if (exMemoTable[key] !== undefined) return exMemoTable[key];

    var numStoch = exCountStoch(st);
    var numOutcomes = 1 << numStoch;
    var prob = 1.0 / numOutcomes;

    var bestVal = -Infinity;
    for (var k = 0; k < 4; k++) {
        if (!exCanMove(st, DIR_KEYS[k])) continue;
        var total = 0;
        for (var out = 0; out < numOutcomes; out++) {
            var child = exClone(st);
            if (!exPlayerMove(child, DIR_KEYS[k], out)) {
                total += EX_DEATH * prob;
            } else {
                total += expectimax(child, depth - 1) * prob;
            }
        }
        if (total > bestVal) bestVal = total;
    }

    exMemoTable[key] = bestVal;
    return bestVal;
}

function expectimaxEval(dirKey) {
    var st = exCloneState();
    var numStoch = exCountStoch(st);
    var depth = numStoch <= 1 ? 5 : numStoch <= 2 ? 4 : 3;
    var numOutcomes = 1 << numStoch;
    var prob = 1.0 / numOutcomes;
    var total = 0;
    for (var out = 0; out < numOutcomes; out++) {
        var branch = exClone(st);
        if (!exPlayerMove(branch, dirKey, out)) {
            total += EX_DEATH * prob;
        } else {
            total += expectimax(branch, depth - 1) * prob;
        }
    }
    return total + exLeafValue(st) * 0.0001;
}

function computeAIMove() {
    var tgt = targetState();

    // Expectimax handles disc escapes natively
    exMemoTable = {}; // Fresh memo per AI decision
    var tmpSt = exCloneState(); // for exCanMove check
    var bestDir = null, bestVal = -Infinity;
    for (var k = 0; k < 4; k++) {
        if (!exCanMove(tmpSt, DIR_KEYS[k])) continue;
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

// ─── Game simulation with per-enemy move countdowns ────────────────────────────
// Each turn = one player hop. Enemies move only when their countdown expires.
var SIM_HOPS_PER_MOVE = {
    egg:       4,   // 35 frames / 8
    coily:     4,   // 28 frames / 8
    redball:   4,   // 30 frames / 8
    greenball: 5,   // 38 frames / 8
    slick:     5    // 40 frames / 8
};

var lives, extraLifeGiven, levelWon, turnCount;

function checkExtraLife() {
    if (!extraLifeGiven && score >= 8000) { extraLifeGiven = true; lives++; }
}

function stompCube(row, col) {
    var cube = cubeAt(row, col);
    if (!cube) return;
    var tgt = targetState();
    if (cube.state < tgt) { cube.state++; score += 25; checkExtraLife(); }
}

function initRound() {
    levelWon = false;
    cubeStates = [];
    for (var r = 0; r < ROWS; r++)
        for (var c = 0; c <= r; c++)
            cubeStates.push({ row: r, col: c, state: 0 });

    player = { row: 0, col: 0, dead: false, deathTimer: 0 };
    stompCube(0, 0);

    discs = [{ side: 0, active: true }, { side: 1, active: true }];
    enemies = [];
    turnCount = 0;
    aiDetailPath = []; aiTourDots = [];
    aiTour = []; aiTourIdx = 0; aiBoardSig = '';

    // Spawn timers in turns (not frames)
    scheduleSpawn(8);              // Coily egg
    scheduleSpawn(4, 'redball');
    if (round >= 3) scheduleSpawn(10, 'greenball');
    if (round >= 4) scheduleSpawn(15, 'slick');
}

function scheduleSpawn(delay, forcedType) {
    enemies.push({ type: 'spawn-timer', timer: delay, forcedType: forcedType || null });
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

    var cd = SIM_HOPS_PER_MOVE[type] || 4;
    if (type === 'egg') {
        enemies.push({ type: 'egg', row: 0, col: 0, hops: 0, moveCountdown: cd });
    } else if (type === 'redball') {
        enemies.push({ type: 'redball', row: spawnRow, col: spawnCol, moveCountdown: cd });
    } else if (type === 'greenball') {
        enemies.push({ type: 'greenball', row: spawnRow, col: spawnCol, moveCountdown: cd });
    } else if (type === 'slick') {
        enemies.push({ type: 'slick', row: spawnRow, col: spawnCol, moveCountdown: cd });
    }
}

function killPlayer() {
    if (player.dead) return;
    player.dead = true;
    player.deathTimer = 3; // 3 turns of death
    lives--;
}

function useDisc(side) {
    discs[side].active = false;
    score += 300; checkExtraLife();
    var survived = [];
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'coily' || e.type === 'egg') { score += 300; checkExtraLife(); }
        else survived.push(e);
    }
    enemies = survived;
    player.row = 0; player.col = 0;
    stompCube(0, 0);
    scheduleSpawn(8);
}

function tryMove(dirKey) {
    if (player.dead) return false;
    var d = DIRS[dirKey]; if (!d) return false;
    var nr = player.row + d.dr, nc = player.col + d.dc;

    if (!isValidPos(nr, nc)) {
        var lRow = discCatchRow(0);
        if (dirKey === 'UL' && player.col === 0 && player.row === lRow && discs[0].active) {
            useDisc(0); return true;
        }
        var rRow = discCatchRow(1);
        if (dirKey === 'UR' && player.col === player.row && player.row === rRow && discs[1].active) {
            useDisc(1); return true;
        }
        killPlayer();
        return false;
    }

    player.row = nr; player.col = nc;
    stompCube(nr, nc);
    checkPlayerEnemyCollision();
    return !player.dead;
}

function checkPlayerEnemyCollision() {
    if (player.dead) return;
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;
        if (e.row === player.row && e.col === player.col) {
            if (e.type === 'slick') {
                score += 300; checkExtraLife();
                enemies.splice(i, 1); i--;
            } else if (e.type === 'greenball') {
                score += 100; checkExtraLife();
                enemies.splice(i, 1); i--;
            } else {
                killPlayer(); return;
            }
        }
    }
}

// Move enemies whose countdown expires this turn
function moveEnemies() {
    // Tick spawn timers
    for (var i = enemies.length - 1; i >= 0; i--) {
        if (enemies[i].type === 'spawn-timer') {
            enemies[i].timer--;
            if (enemies[i].timer <= 0) {
                var ft = enemies[i].forcedType;
                enemies.splice(i, 1);
                spawnEnemy(ft);
            }
        }
    }

    // Tick countdown and move only enemies whose countdown reaches 0
    for (var i = enemies.length - 1; i >= 0; i--) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;

        e.moveCountdown--;
        if (e.moveCountdown > 0) continue;
        e.moveCountdown = SIM_HOPS_PER_MOVE[e.type] || 4;

        if (e.type === 'egg') {
            var dir = Math.random() < 0.5 ? 'DL' : 'DR';
            var delta = DIRS[dir];
            var nr = e.row + delta.dr, nc = e.col + delta.dc;
            if (isValidPos(nr, nc)) {
                e.hops++;
                e.row = nr; e.col = nc;
                if (e.hops >= 6 || nr >= ROWS - 1) {
                    e.type = 'coily';
                }
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
            if (bestDir) {
                e.row = bestDir.nr; e.col = bestDir.nc;
            } else {
                enemies.splice(i, 1);
                scheduleSpawn(8);
                continue;
            }
        } else if (e.type === 'redball') {
            var rbdir = Math.random() < 0.5 ? 'DL' : 'DR';
            var rbdelta = DIRS[rbdir];
            var rbnr = e.row + rbdelta.dr, rbnc = e.col + rbdelta.dc;
            if (isValidPos(rbnr, rbnc)) {
                e.row = rbnr; e.col = rbnc;
            } else {
                enemies.splice(i, 1);
                scheduleSpawn(Math.max(5, 8 - Math.floor(round / 2)), 'redball');
                continue;
            }
        } else if (e.type === 'greenball') {
            var gbdir = Math.random() < 0.5 ? 'DL' : 'DR';
            var gbdelta = DIRS[gbdir];
            var gbnr = e.row + gbdelta.dr, gbnc = e.col + gbdelta.dc;
            if (isValidPos(gbnr, gbnc)) {
                e.row = gbnr; e.col = gbnc;
            } else {
                enemies.splice(i, 1);
                if (round >= 3) scheduleSpawn(12, 'greenball');
                continue;
            }
        } else if (e.type === 'slick') {
            var sdir = Math.random() < 0.5 ? 'DL' : 'DR';
            var sdelta = DIRS[sdir];
            var snr = e.row + sdelta.dr, snc = e.col + sdelta.dc;
            if (isValidPos(snr, snc)) {
                e.row = snr; e.col = snc;
            } else {
                enemies.splice(i, 1);
                if (round >= 4) scheduleSpawn(15, 'slick');
                continue;
            }
        }
    }

    // Apply slick effects and check collisions after all moves
    for (var i = enemies.length - 1; i >= 0; i--) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;

        if (e.type === 'slick') {
            var cube = cubeAt(e.row, e.col);
            if (cube && cube.state > 0) cube.state--;
            if (e.row >= ROWS - 1) {
                enemies.splice(i, 1);
                if (round >= 4) scheduleSpawn(15, 'slick');
                continue;
            }
        }

        if (!player.dead && e.row === player.row && e.col === player.col) {
            if (e.type === 'slick') {
                score += 300; checkExtraLife();
                enemies.splice(i, 1);
            } else if (e.type === 'greenball') {
                score += 100; checkExtraLife();
                enemies.splice(i, 1);
            } else {
                killPlayer();
            }
        }
    }
}

// One turn: AI picks move, player moves, enemies move
function simTurn() {
    turnCount++;
    if (levelWon) return null;

    // Handle death
    if (player.dead) {
        player.deathTimer--;
        if (player.deathTimer <= 0 && lives > 0) {
            player.dead = false;
            player.row = 0; player.col = 0;
            stompCube(0, 0);
            var kept = [];
            for (var i = 0; i < enemies.length; i++)
                if (enemies[i].type === 'spawn-timer') kept.push(enemies[i]);
            enemies = kept;
            scheduleSpawn(7);
            scheduleSpawn(5, 'redball');
            if (round >= 4) scheduleSpawn(13, 'slick');
            if (round >= 3) scheduleSpawn(10, 'greenball');
        }
        return null;
    }

    // AI computes move
    var dir = computeAIMove();
    if (!dir) return null;

    // Player moves
    if (!tryMove(dir)) return dir;

    // Check round complete
    if (!player.dead && allColored()) {
        score += 1000; checkExtraLife();
        levelWon = true;
        return dir;
    }

    // Enemies move
    if (!player.dead) moveEnemies();

    return dir;
}

// ─── Visualization ─────────────────────────────────────────────────────────────
function drawBoard() {
    var tgt = targetState();
    var grid = {};
    for (var i = 0; i < cubeStates.length; i++) {
        var c = cubeStates[i];
        grid[c.row + ',' + c.col] = c.state >= tgt ? '#' : '.';
    }
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

// ─── Run simulation (turn-based) ──────────────────────────────────────────────
function runGame(maxRounds, verbose) {
    round = 1;
    score = 0;
    lives = 3;
    extraLifeGiven = false;
    var totalDeaths = 0;
    var prevLives = lives;

    for (; round <= maxRounds; round++) {
        initRound();
        var moveNum = 0;
        var maxTurns = 500; // safety limit

        if (verbose) {
            console.log('\n' + '='.repeat(50));
            console.log('ROUND ' + round + ' (target: ' + targetState() + ')');
            console.log('='.repeat(50));
        }

        for (var turn = 0; turn < maxTurns; turn++) {
            var aiMove = simTurn();

            // Track deaths
            if (lives < prevLives) {
                totalDeaths += prevLives - lives;
                if (verbose) console.log('  Turn ' + turn + ': DIED! Lives=' + lives);
                prevLives = lives;
            }
            if (lives <= 0) {
                console.log('GAME OVER at round ' + round + ', move ' + moveNum + ', score=' + score);
                return { rounds: round, score: score, deaths: totalDeaths };
            }

            if (aiMove) {
                moveNum++;
                if (verbose) {
                    var remaining = countRemaining();
                    var extra = '';
                    if (remaining <= 3) {
                        var tgt = targetState();
                        var uncolored = [];
                        for (var ci = 0; ci < cubeStates.length; ci++)
                            if (cubeStates[ci].state < tgt) uncolored.push('(' + cubeStates[ci].row + ',' + cubeStates[ci].col + ')');
                        extra = '  need=' + uncolored.join(',');
                    }
                    console.log('  Move ' + moveNum + ': ' + aiMove +
                        ' -> (' + player.row + ',' + player.col + ')  remaining=' + remaining +
                        '  enemies: ' + enemySummary() + extra);
                    if (moveNum % 10 === 0) console.log(drawBoard());
                }
            }

            if (levelWon) {
                round++;
                if (verbose) console.log('  Round ' + (round-1) + ' COMPLETE in ' + moveNum + ' moves! Score=' + score);
                else console.log('Round ' + (round-1) + ' done in ' + moveNum + ' moves, deaths=' + totalDeaths + ', score=' + score);
                break;
            }
        }

        if (!levelWon && turn >= maxTurns) {
            console.log('  Round ' + round + ' TIMEOUT after ' + maxTurns + ' turns');
        }

        // levelWon already incremented round, so adjust
        if (levelWon) { round--; } // for-loop will increment
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
