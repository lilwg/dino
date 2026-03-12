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

// Arcade: Q*bert=9f, enemies=12f land-to-land → ratio 3:4
// Enemy moves once per 1.33 Q*bert hops (round to 1)
var EX_HOPS_PER_MOVE = {
    egg:      1,   // 12f / 9f ≈ 1.33 player hops
    coily:    1,   // 12f / 9f ≈ 1.33 player hops
    redball:  1,   // 12f / 9f ≈ 1.33 player hops
    ugg:      1,   // 12f / 9f ≈ 1.33 player hops
    wrongway: 1    // 12f / 9f ≈ 1.33 player hops
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
    var gs = (typeof gameSpeed !== 'undefined') ? gameSpeed : 1.0;
    return Math.min(2.0, 1.0 + (lv - 1) * 0.2) * gs;
}

// Disc counts per level/round from original arcade manual
function discCount() {
    var lv = arcadeLevel();
    var r = ((round - 1) % 4);
    if (lv === 1) return 2;
    if (lv === 2) return [3, 3, 3, 2][r];
    if (lv === 3) return [4, 4, 3, 3][r];
    if (lv === 4) return [6, 6, 5, 4][r];
    return [7, 6, 6, 5][r]; // Level 5+
}

function discConfig() {
    var count = discCount();
    var r = ((round - 1) % 4);
    // Build disc placements, varying positions per round
    var result = [];
    result.push({side: 0, row: [2,3,2,3][r]});
    result.push({side: 1, row: [3,2,3,2][r]});
    if (count >= 3) result.push({side: [0,1,0,1][r], row: [4,4,5,4][r]});
    if (count >= 4) result.push({side: [1,0,1,0][r], row: [5,5,4,5][r]});
    if (count >= 5) result.push({side: 0, row: [5,4,3,5][r]});
    if (count >= 6) result.push({side: 1, row: [4,5,5,3][r]});
    if (count >= 7) result.push({side: [0,1,0,1][r], row: [3,3,4,4][r]});
    return result;
}

// Round completion bonus: 750 + 250*round, max 5000
function roundCompletionBonus() {
    return Math.min(5000, 750 + 250 * round);
}

// Unused disc bonus: 50 pts per remaining disc
function unusedDiscBonus() {
    var count = 0;
    for (var i = 0; i < discs.length; i++)
        if (discs[i].active) count++;
    return count * 50;
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

// ─── Position indexing for bitmask operations ────────────────────────────────
var POS_COUNT = ROWS * (ROWS + 1) / 2; // 28
var posToIdx = [];  // flat: posToIdx[row * ROWS + col] = index (0..27)
var idxToPos = [];  // index → [row, col]
(function() {
    for (var i = 0; i < ROWS * ROWS; i++) posToIdx.push(-1);
    var idx = 0;
    for (var r = 0; r < ROWS; r++)
        for (var c = 0; c <= r; c++) {
            posToIdx[r * ROWS + c] = idx;
            idxToPos.push([r, c]);
            idx++;
        }
})();

// Precomputed flat distance matrix (28×28)
var distMatrix = new Int8Array(POS_COUNT * POS_COUNT);
(function() {
    for (var i = 0; i < POS_COUNT; i++)
        for (var j = 0; j < POS_COUNT; j++)
            distMatrix[i * POS_COUNT + j] = exBfsDist(idxToPos[i][0], idxToPos[i][1],
                                                       idxToPos[j][0], idxToPos[j][1]);
})();

// Adjacency list for each position (for Dijkstra)
var posAdj = [];  // posAdj[i] = array of neighbor indices
(function() {
    for (var i = 0; i < POS_COUNT; i++) {
        var adj = [];
        var r = idxToPos[i][0], c = idxToPos[i][1];
        for (var k = 0; k < 4; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = r + dk.dr, nc = c + dk.dc;
            if (isValidPos(nr, nc)) adj.push(posToIdx[nr * ROWS + nc]);
        }
        posAdj.push(adj);
    }
})();

// Dijkstra from one source with weighted edges (completed cubes cost 3)
// Returns distances to all 28 positions
function dijkstraWeighted(srcIdx, completedBits) {
    var dist = new Float32Array(POS_COUNT);
    var visited = new Uint8Array(POS_COUNT);
    for (var i = 0; i < POS_COUNT; i++) dist[i] = 999;
    dist[srcIdx] = 0;
    for (var iter = 0; iter < POS_COUNT; iter++) {
        var u = -1, minD = 999;
        for (var i = 0; i < POS_COUNT; i++) {
            if (!visited[i] && dist[i] < minD) { minD = dist[i]; u = i; }
        }
        if (u < 0) break;
        visited[u] = 1;
        var adj = posAdj[u];
        for (var a = 0; a < adj.length; a++) {
            var v = adj[a];
            if (visited[v]) continue;
            var w = (completedBits[v >> 5] & (1 << (v & 31))) ? 3 : 1;
            var nd = minD + w;
            if (nd < dist[v]) dist[v] = nd;
        }
    }
    return dist;
}

// Held-Karp optimal tour cost for small target sets
// allDists: flat (N+1)×(N+1) distance matrix where index 0=start, 1..N=targets
// N: number of targets (must be ≤ 10)
function heldKarp(allDists, N) {
    if (N === 0) return 0;
    var M = N + 1; // total positions (start + targets)
    if (N === 1) return allDists[0 * M + 1];
    var FULL = (1 << N) - 1;
    var dp = new Float32Array((FULL + 1) * N);
    for (var i = 0; i < dp.length; i++) dp[i] = 999;
    // Base: start → each single target
    for (var i = 0; i < N; i++)
        dp[(1 << i) * N + i] = allDists[0 * M + (i + 1)];
    // Fill DP
    for (var mask = 1; mask <= FULL; mask++) {
        for (var last = 0; last < N; last++) {
            if (!(mask & (1 << last))) continue;
            var cost = dp[mask * N + last];
            if (cost >= 998) continue;
            for (var next = 0; next < N; next++) {
                if (mask & (1 << next)) continue;
                var nc = cost + allDists[(last + 1) * M + (next + 1)];
                var idx = (mask | (1 << next)) * N + next;
                if (nc < dp[idx]) dp[idx] = nc;
            }
        }
    }
    var best = 999;
    for (var i = 0; i < N; i++)
        if (dp[FULL * N + i] < best) best = dp[FULL * N + i];
    return best;
}

// ─── A* revert-aware tour cost ───────────────────────────────────────────────
// Binary min-heap for A* priority queue
function AStarHeap() {
    this.data = [];
}
AStarHeap.prototype.push = function(node) {
    this.data.push(node);
    var i = this.data.length - 1;
    while (i > 0) {
        var p = (i - 1) >> 1;
        if (this.data[p].f <= this.data[i].f) break;
        var tmp = this.data[p]; this.data[p] = this.data[i]; this.data[i] = tmp;
        i = p;
    }
};
AStarHeap.prototype.pop = function() {
    var top = this.data[0];
    var last = this.data.pop();
    if (this.data.length > 0) {
        this.data[0] = last;
        var i = 0, n = this.data.length;
        while (true) {
            var l = 2*i+1, r = 2*i+2, smallest = i;
            if (l < n && this.data[l].f < this.data[smallest].f) smallest = l;
            if (r < n && this.data[r].f < this.data[smallest].f) smallest = r;
            if (smallest === i) break;
            var tmp = this.data[i]; this.data[i] = this.data[smallest]; this.data[smallest] = tmp;
            i = smallest;
        }
    }
    return top;
};
AStarHeap.prototype.size = function() { return this.data.length; };

// Compute revert penalty: how many stomps a completed cube needs after being reverted
function revertStomps(lv, tgt) {
    // Level 3: state toggles 0↔1, target=1. Revert: 1→0, needs 1 stomp
    // Level 4: state 2→1, else +1, target=2. Revert: 2→1, needs 1 stomp
    // Level 5+: state cycles 0→1→2→0, target=2. Revert: 2→0, needs 2 stomps
    if (lv <= 4) return 1;
    return tgt; // level 5+: needs full tgt stomps
}

// MST heuristic using precomputed distMatrix (admissible: ignores reverts)
// pos: current position index, needsLo/needsHi: packed cube needs (2 bits per cube)
// needsLo bit i = cube i needs >= 1 stomp, needsHi bit i = cube i needs >= 2 stomps
function astarMST(pos, needsLo, needsHi) {
    // Collect target positions
    var nodes = [pos];
    var extraStomps = 0;
    for (var i = 0; i < POS_COUNT; i++) {
        if (needsLo & (1 << i)) {
            nodes.push(i);
            if (needsHi & (1 << i)) extraStomps++; // needs 2 stomps, 1 extra
        }
    }
    if (nodes.length <= 1) return extraStomps * 2;

    // Prim's MST
    var n = nodes.length;
    var inMST = new Uint8Array(n);
    var minEdge = new Int8Array(n);
    for (var i = 0; i < n; i++) minEdge[i] = 99;
    minEdge[0] = 0;
    var mstCost = 0;

    for (var iter = 0; iter < n; iter++) {
        var u = -1, minVal = 99;
        for (var i = 0; i < n; i++) {
            if (!inMST[i] && minEdge[i] < minVal) {
                minVal = minEdge[i]; u = i;
            }
        }
        if (u < 0) break;
        inMST[u] = 1;
        mstCost += minVal;
        for (var v = 0; v < n; v++) {
            if (inMST[v]) continue;
            var d = distMatrix[nodes[u] * POS_COUNT + nodes[v]];
            if (d < minEdge[v]) minEdge[v] = d;
        }
    }

    return mstCost + extraStomps * 2;
}

// A* search for exact minimum moves to complete all cubes on revert levels.
// Models the revert mechanic: stepping on completed cubes reverts them.
// Uses MST of remaining targets (ignoring reverts) as admissible heuristic.
var ASTAR_NODE_LIMIT = 5000;
var astarTourCache = {};
var astarTourCacheHits = 0;
var astarTourCacheMisses = 0;

function astarRevertTourCost(st) {
    var tgt = st.tgt;
    var lv = st.lv !== undefined ? st.lv : arcadeLevel();
    var revPenalty = revertStomps(lv, tgt);

    // Build initial needs: 2 bits per cube packed into two ints
    // needsLo bit i = cube i needs >= 1 stomp
    // needsHi bit i = cube i needs >= 2 stomps
    var needsLo = 0, needsHi = 0;
    var cubeExistsMask = 0; // which positions have cubes
    var totalNeeded = 0;
    for (var i = 0; i < st.cubes.length; i++) {
        var idx = posToIdx[st.cubes[i].row * ROWS + st.cubes[i].col];
        cubeExistsMask |= (1 << idx);
        var needed = tgt - st.cubes[i].state;
        if (needed > 0) {
            needsLo |= (1 << idx);
            if (needed >= 2) needsHi |= (1 << idx);
            totalNeeded += needed;
        }
    }
    if (totalNeeded === 0) return 0;

    var startPos = posToIdx[st.pr * ROWS + st.pc];

    // Check cache
    var cacheKey = startPos + '|' + needsLo + '|' + needsHi + '|' + cubeExistsMask + '|' + revPenalty;
    if (astarTourCache[cacheKey] !== undefined) {
        astarTourCacheHits++;
        return astarTourCache[cacheKey];
    }
    astarTourCacheMisses++;

    // State key: pos | needsLo | needsHi (packed as string)
    function sKey(p, lo, hi) {
        return p + '|' + lo + '|' + hi;
    }

    var open = new AStarHeap();
    var gBest = {};
    var h0 = astarMST(startPos, needsLo, needsHi);
    var initKey = sKey(startPos, needsLo, needsHi);
    open.push({ pos: startPos, lo: needsLo, hi: needsHi, g: 0, f: h0, key: initKey });
    gBest[initKey] = 0;

    var nodesExpanded = 0;

    while (open.size() > 0) {
        var cur = open.pop();

        // Goal check: no cubes need stomping
        if (cur.lo === 0) {
            if (typeof astarStats !== 'undefined') {
                astarStats.solved++;
                astarStats.totalNodes += nodesExpanded;
            }
            astarTourCache[cacheKey] = cur.g;
            return cur.g;
        }

        // Skip if we've found a better path to this state
        if (gBest[cur.key] !== undefined && gBest[cur.key] < cur.g) continue;

        nodesExpanded++;
        if (nodesExpanded > ASTAR_NODE_LIMIT) {
            // Fall back to MST estimate if too many nodes
            if (typeof astarStats !== 'undefined') {
                astarStats.fallbacks++;
                astarStats.totalNodes += nodesExpanded;
            }
            var fallback = cur.g + astarMST(cur.pos, cur.lo, cur.hi);
            astarTourCache[cacheKey] = fallback;
            return fallback;
        }

        // Expand neighbors
        var adj = posAdj[cur.pos];
        for (var a = 0; a < adj.length; a++) {
            var np = adj[a];
            var newG = cur.g + 1;
            var newLo = cur.lo, newHi = cur.hi;
            var bit = 1 << np;

            if (cubeExistsMask & bit) {
                if (newLo & bit) {
                    // Cube needs stomping
                    if (newHi & bit) {
                        // Needs 2+ stomps: first stomp reduces to 1
                        newHi &= ~bit;
                    } else {
                        // Needs exactly 1 stomp: done!
                        newLo &= ~bit;
                    }
                } else {
                    // Completed cube: stepping on it reverts!
                    newLo |= bit;
                    if (revPenalty >= 2) newHi |= bit;
                }
            }

            var nKey = sKey(np, newLo, newHi);
            if (gBest[nKey] !== undefined && gBest[nKey] <= newG) continue;
            gBest[nKey] = newG;

            var h = astarMST(np, newLo, newHi);
            open.push({ pos: np, lo: newLo, hi: newHi, g: newG, f: newG + h, key: nKey });
        }
    }

    // No solution (shouldn't happen on valid board)
    astarTourCache[cacheKey] = 999;
    return 999;
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
                // 500pts per Coily/egg lured off; clear ALL enemies
                for (var i = 0; i < st.enemies.length; i++) {
                    if (st.enemies[i].type === 'coily' || st.enemies[i].type === 'egg')
                        st.score += 500;
                }
                st.enemies = [];
                st.pr = 0; st.pc = 0;
                return true;
            }
            if (disc.side === 1 && dirKey === 'UR' && st.pc === st.pr && st.pr === disc.row) {
                disc.active = false;
                for (var i = 0; i < st.enemies.length; i++) {
                    if (st.enemies[i].type === 'coily' || st.enemies[i].type === 'egg')
                        st.score += 500;
                }
                st.enemies = [];
                st.pr = 0; st.pc = 0;
                return true;
            }
        }
        st.alive = false; return false;
    }
    st.pr = nr; st.pc = nc;
    // Check enemy collision BEFORE level completion (matches actual game order)
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        if (e.row === nr && e.col === nc) {
            if (e.type === 'coily' || e.type === 'redball' || e.type === 'egg' ||
                e.type === 'ugg' || e.type === 'wrongway') {
                st.alive = false; return false;
            }
        }
    }
    var cube = exCubeAt(st, nr, nc);
    if (cube) {
        var oldC = Math.min(cube.state, st.tgt);
        cube.state = nextCubeState(cube.state);
        var newC = Math.min(cube.state, st.tgt);
        st.cubesColored += newC - oldC;
        if (newC > oldC) {
            st.score += (cube.state === st.tgt) ? 25 : 15;
        }
    }
    if (st.cubesColored >= st.cubes.length * st.tgt) {
        st.score += EX_WIN; st.enemies = []; return true;
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

    // Collect unique remaining target positions and count multi-hits
    var targetIdxs = [];
    var targetSeen = {};
    var totalHits = 0;
    for (var i = 0; i < st.cubes.length; i++) {
        var hitsNeeded = st.tgt - st.cubes[i].state;
        if (hitsNeeded <= 0) continue;
        totalHits += hitsNeeded;
        var idx = posToIdx[st.cubes[i].row * ROWS + st.cubes[i].col];
        if (!targetSeen[idx]) {
            targetSeen[idx] = true;
            targetIdxs.push(idx);
        }
    }
    if (targetIdxs.length === 0) return 0;

    var startIdx = posToIdx[st.pr * ROWS + st.pc];
    var N = targetIdxs.length;

    // Use A* for revert levels with few remaining targets — exact cost with reverts
    // When many cubes remain, the revert risk is low and A* state space is too large
    // A* for revert levels — only when very few targets remain
    // Disabled inside expectimax (too slow per call); enabled for standalone evaluation
    if (isRevert && N <= 5 && typeof astarEnabled !== 'undefined' && astarEnabled)
        return astarRevertTourCost(st);

    // Use Held-Karp for small N (≤ 10 unique targets)
    if (N <= 10) {
        var allPos = [startIdx].concat(targetIdxs);
        var M = allPos.length;
        var dists = new Float32Array(M * M);

        if (isRevert) {
            // Build completed bitmask
            var completedBits = new Int32Array(1);
            for (var i = 0; i < st.cubes.length; i++) {
                if (st.cubes[i].state >= st.tgt) {
                    var ci = posToIdx[st.cubes[i].row * ROWS + st.cubes[i].col];
                    completedBits[ci >> 5] |= (1 << (ci & 31));
                }
            }
            for (var s = 0; s < M; s++) {
                var dd = dijkstraWeighted(allPos[s], completedBits);
                for (var d = 0; d < M; d++)
                    dists[s * M + d] = dd[allPos[d]];
            }
        } else {
            for (var s = 0; s < M; s++)
                for (var d = 0; d < M; d++)
                    dists[s * M + d] = distMatrix[allPos[s] * POS_COUNT + allPos[d]];
        }

        var cost = heldKarp(dists, N);
        // Extra cost for multi-hit cubes (need to leave and revisit)
        var extraHits = totalHits - N;
        cost += extraHits * 2;
        return cost;
    }

    // Fall back to greedy nearest-neighbor for large N
    var completedFrac = 0;
    if (isRevert) {
        var numCompleted = 0;
        for (var i = 0; i < st.cubes.length; i++)
            if (st.cubes[i].state >= st.tgt) numCompleted++;
        completedFrac = numCompleted / st.cubes.length;
    }
    var totalDist = 0;
    var cr = st.pr, cc = st.pc;
    var used = new Array(totalHits);
    var remaining = [];
    for (var i = 0; i < st.cubes.length; i++) {
        var hitsNeeded2 = st.tgt - st.cubes[i].state;
        if (hitsNeeded2 <= 0) continue;
        for (var h = 0; h < hitsNeeded2; h++)
            remaining.push(st.cubes[i]);
    }
    for (var step = 0; step < remaining.length; step++) {
        var bestIdx = -1, bestDist = 99;
        for (var j = 0; j < remaining.length; j++) {
            if (used[j]) continue;
            var d = exBfsDist(cr, cc, remaining[j].row, remaining[j].col);
            if (d === 0) d = 2;
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
        val -= completedNeighbors * 20;
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
