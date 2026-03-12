// qbert-ai.js — Shared AI logic for Q*bert dino game
// Used by both dino-qbert.html (via <script src>) and test-ai.js (via eval).
//
// Globals required from including file:
//   round, player, enemies, cubeStates, discs
//   aiTour, aiTourIdx, aiBoardSig
//
// Globals provided by this file:
//   ROWS, DIRS, DIR_KEYS, EX_HOPS_PER_MOVE, EX_DEATH, EX_WIN, exMemoTable
//   All AI/expectimax functions, BFS, tour planning, danger maps
//   Board utility functions (isValidPos, arcadeLevel, targetState, etc.)
//
// exCloneState() must be defined by the including file (differs between game/test).

// ─── Core constants ──────────────────────────────────────────────────────────
var ROWS = 7;
var DIRS = { UL: {dr:-1, dc:-1}, UR: {dr:-1, dc:0}, DL: {dr:1, dc:0}, DR: {dr:1, dc:1} };
var DIR_KEYS = ['UL', 'UR', 'DL', 'DR'];

var EX_HOPS_PER_MOVE = {
    egg:      3,   // 35 frames / 12 ≈ 3 player hops
    coily:    2,   // 28 frames / 12 ≈ 2 player hops
    redball:  3,   // 30 frames / 12 ≈ 3 player hops
    ugg:      3,   // ~30 frames / 12 ≈ 3 player hops
    wrongway: 3    // ~30 frames / 12 ≈ 3 player hops
};

var EX_DEATH = -50000;
var EX_WIN   =  50000;

// ─── Board functions ─────────────────────────────────────────────────────────
function isValidPos(row, col) {
    return row >= 0 && row < ROWS && col >= 0 && col <= row;
}

function cubeAt(row, col) {
    if (!isValidPos(row, col)) return null;
    for (var i = 0; i < cubeStates.length; i++)
        if (cubeStates[i].row === row && cubeStates[i].col === col) return cubeStates[i];
    return null;
}

// Arcade level progression: 9 levels × 4 rounds each
function arcadeLevel() { return Math.min(9, Math.ceil(round / 4)); }

function targetState() {
    var lv = arcadeLevel();
    return (lv === 1 || lv === 3) ? 1 : 2;
}

// Returns next cube state after stomping, per arcade level rules
function nextCubeState(state) {
    var lv = arcadeLevel();
    var tgt = targetState();
    if (lv <= 2) return Math.min(state + 1, tgt);
    if (lv === 3) return state === 0 ? 1 : 0;
    if (lv === 4) return state === 2 ? 1 : state + 1;
    return (state + 1) % 3;
}

function allColored() {
    var tgt = targetState();
    for (var i = 0; i < cubeStates.length; i++)
        if (cubeStates[i].state < tgt) return false;
    return true;
}

function speedMultiplier() {
    var lv = arcadeLevel();
    return Math.min(2.0, 1.0 + (lv - 1) * 0.2);
}

function discConfig() {
    var lv = arcadeLevel();
    var r = ((round - 1) % 4);
    if (lv === 1) {
        return [{side: 0, row: [2,3,4,2][r]}, {side: 1, row: [3,2,3,4][r]}];
    } else if (lv === 2) {
        return [{side: 0, row: [2,3,2,3][r]}, {side: 1, row: [3,2,4,3][r]}, {side: [0,1,0,1][r], row: [4,4,3,2][r]}];
    } else if (lv <= 4) {
        return [{side: 0, row: 2}, {side: 1, row: 2}, {side: 0, row: [4,3,5,4][r]}, {side: 1, row: [3,4,4,5][r]}];
    } else {
        return [{side: 0, row: 2}, {side: 1, row: 2}, {side: 0, row: 4}, {side: 1, row: 4}, {side: [0,1,0,1][r], row: [3,3,5,5][r]}];
    }
}

// ─── BFS pathfinding ─────────────────────────────────────────────────────────
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

function boardSig() {
    var s = '';
    for (var i = 0; i < cubeStates.length; i++) s += cubeStates[i].state;
    return s;
}

// ─── Danger maps ─────────────────────────────────────────────────────────────
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

// ─── Tour planning ───────────────────────────────────────────────────────────
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
    aiTour    = tour;
    aiTourIdx = 0;
    aiBoardSig = boardSig();
}

// ─── Precomputed pairwise BFS distances ──────────────────────────────────────
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

// ─── Expectimax search ───────────────────────────────────────────────────────
function exCubeAt(st, row, col) {
    for (var i = 0; i < st.cubes.length; i++)
        if (st.cubes[i].row === row && st.cubes[i].col === col) return st.cubes[i];
    return null;
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
    var ds = [];
    for (var i = 0; i < st.discs.length; i++)
        ds.push({ side: st.discs[i].side, row: st.discs[i].row, active: st.discs[i].active });
    return { pr: st.pr, pc: st.pc, cubes: cs, enemies: ens,
             alive: st.alive, score: st.score, cubesColored: st.cubesColored, tgt: st.tgt,
             discs: ds, lv: st.lv };
}

function exMoveEnemies(st, stochOutcome) {
    var stochBit = 0;
    for (var i = st.enemies.length - 1; i >= 0; i--) {
        var e = st.enemies[i];
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
        } else if (e.type === 'ugg' || e.type === 'wrongway') {
            // Ugg/Wrongway move sideways on pyramid faces — random up or sideways
            var dir = ((stochOutcome >> stochBit) & 1);
            stochBit++;
            var nr, nc;
            if (e.type === 'ugg') {
                // Ugg: spawns bottom-right, moves up-left. Choices: UL or UR (up vs sideways-left)
                if (dir) { nr = e.row - 1; nc = e.col - 1; } // UL
                else     { nr = e.row - 1; nc = e.col; }     // UR
            } else {
                // Wrongway: spawns bottom-left, moves up-right. Choices: UR or UL (up vs sideways-right)
                if (dir) { nr = e.row - 1; nc = e.col; }     // UR
                else     { nr = e.row - 1; nc = e.col - 1; } // UL
            }
            if (isValidPos(nr, nc)) {
                e.row = nr; e.col = nc;
            } else {
                st.enemies.splice(i, 1);
            }
        }
    }
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        if (e.row === st.pr && e.col === st.pc) {
            if (e.type === 'coily' || e.type === 'redball' || e.type === 'egg' ||
                e.type === 'ugg' || e.type === 'wrongway') {
                st.alive = false; return;
            }
        }
    }
}

function exPlayerMove(st, dirKey, stochOutcome) {
    if (!st.alive) return false;
    var d = DIRS[dirKey];
    var nr = st.pr + d.dr, nc = st.pc + d.dc;
    if (!isValidPos(nr, nc)) {
        for (var di = 0; di < st.discs.length; di++) {
            var disc = st.discs[di];
            if (!disc.active) continue;
            if (disc.side === 0 && dirKey === 'UL' && st.pc === 0 && st.pr === disc.row) {
                disc.active = false;
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
            if (disc.side === 1 && dirKey === 'UR' && st.pc === st.pr && st.pr === disc.row) {
                disc.active = false;
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
        }
        st.alive = false; return false;
    }
    st.pr = nr; st.pc = nc;
    var cube = exCubeAt(st, nr, nc);
    if (cube) {
        var oldC = Math.min(cube.state, st.tgt);
        cube.state = nextCubeState(cube.state);
        var newC = Math.min(cube.state, st.tgt);
        st.cubesColored += newC - oldC;
        if (newC > oldC) st.score += 25;
    }
    if (st.cubesColored >= st.cubes.length * st.tgt) {
        st.score += 1000; st.enemies = []; return true;
    }
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        if (e.row === nr && e.col === nc) {
            if (e.type === 'coily' || e.type === 'redball' || e.type === 'egg' ||
                e.type === 'ugg' || e.type === 'wrongway') {
                st.alive = false; return false;
            }
        }
    }
    exMoveEnemies(st, stochOutcome);
    return st.alive;
}

function exCountStoch(st) {
    var count = 0;
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        if ((e.type === 'egg' || e.type === 'redball' || e.type === 'ugg' || e.type === 'wrongway') && e.countdown <= 1) count++;
    }
    return Math.min(count, 5);
}

function exTourCost(st) {
    var lv = st.lv !== undefined ? st.lv : arcadeLevel();
    var isRevert = lv >= 3;
    var remaining = [];
    for (var i = 0; i < st.cubes.length; i++) {
        var hitsNeeded = st.tgt - st.cubes[i].state;
        if (hitsNeeded <= 0) continue;
        for (var h = 0; h < hitsNeeded; h++)
            remaining.push(st.cubes[i]);
    }
    if (remaining.length === 0) return 0;

    // On revert levels, estimate crossing penalty per hop
    var completedFrac = 0;
    if (isRevert) {
        var numCompleted = 0;
        for (var i = 0; i < st.cubes.length; i++)
            if (st.cubes[i].state >= st.tgt) numCompleted++;
        completedFrac = numCompleted / st.cubes.length;
    }

    var totalDist = 0;
    var cr = st.pr, cc = st.pc;
    var used = new Array(remaining.length);
    for (var step = 0; step < remaining.length; step++) {
        var bestIdx = -1, bestDist = 99;
        for (var j = 0; j < remaining.length; j++) {
            if (used[j]) continue;
            var d = exBfsDist(cr, cc, remaining[j].row, remaining[j].col);
            if (d === 0) d = 2;
            // On revert levels, each hop has probability completedFrac of crossing
            // a completed cube, costing 2 extra (uncomplete + re-complete later)
            if (isRevert && d > 1) d += Math.round((d - 1) * completedFrac * 2);
            if (d < bestDist) { bestDist = d; bestIdx = j; }
        }
        if (bestIdx < 0) break;
        used[bestIdx] = true;
        totalDist += bestDist;
        cr = remaining[bestIdx].row; cc = remaining[bestIdx].col;
    }
    return totalDist;
}

function exStateKey(st, depth) {
    var k = st.pr + ',' + st.pc + '|';
    for (var i = 0; i < st.cubes.length; i++) k += st.cubes[i].state;
    k += '|';
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        k += e.type[0] + e.row + ',' + e.col + 'c' + e.countdown + ';';
    }
    k += '|' + depth + '|';
    for (var i = 0; i < st.discs.length; i++) k += st.discs[i].active ? 1 : 0;
    return k;
}

var exMemoTable = {};

function exLeafValue(st) {
    if (!st.alive) return EX_DEATH;
    if (st.cubesColored >= st.cubes.length * st.tgt) return EX_WIN;
    var tourCost = exTourCost(st);
    var val = st.cubesColored * 100 - tourCost * 10;
    // On revert levels, penalize being surrounded by completed cubes (trap avoidance)
    var lv = st.lv !== undefined ? st.lv : arcadeLevel();
    if (lv >= 3) {
        var completedNeighbors = 0;
        for (var k = 0; k < 4; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = st.pr + dk.dr, nc = st.pc + dk.dc;
            if (!isValidPos(nr, nc)) continue;
            var cube = exCubeAt(st, nr, nc);
            if (cube && cube.state >= st.tgt) completedNeighbors++;
        }
        // Each completed neighbor is a potential trap — penalize heavily
        val -= completedNeighbors * 30;
    }
    return val;
}

function exCanMove(st, dirKey) {
    var d = DIRS[dirKey];
    var nr = st.pr + d.dr, nc = st.pc + d.dc;
    if (isValidPos(nr, nc)) return true;
    for (var di = 0; di < st.discs.length; di++) {
        var disc = st.discs[di];
        if (!disc.active) continue;
        if (disc.side === 0 && dirKey === 'UL' && st.pc === 0 && st.pr === disc.row) return true;
        if (disc.side === 1 && dirKey === 'UR' && st.pc === st.pr && st.pr === disc.row) return true;
    }
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
