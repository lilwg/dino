// qbert-ai.js — Shared AI logic for Q*bert dino game
// Used by both dino-qbert.html (via <script src>) and test-ai.js (via eval).
//
// Globals required from including file:
//   round, player, enemies, cubeStates, discs
//   aiTour, aiTourIdx, aiBoardSig
//
// Globals provided by this file:
//   ROWS, DIRS, DIR_KEYS, EX_MOVE_RATE, EX_DEATH, EX_WIN, exMemoTable
//   All AI/expectimax functions, BFS, tour planning, danger maps
//   aiPickBestDir() — main entry point for choosing AI direction (with anti-oscillation)
//   Board utility functions (isValidPos, arcadeLevel, targetState, etc.)
//
// exCloneState() must be defined by the including file (differs between game/test).

// ─── Core constants ──────────────────────────────────────────────────────────
var ROWS = 7;
var DIRS = { UL: {dr:-1, dc:-1}, UR: {dr:-1, dc:0}, DL: {dr:1, dc:0}, DR: {dr:1, dc:1} };
var DIR_KEYS = ['UL', 'UR', 'DL', 'DR'];

// Arcade frame-accurate speeds: each player hop (9f), enemies accumulate
// 9/enemy_frames toward their next move. Enemy moves when accumulator >= 1.0.
// Q*bert=9f, Coily=12f, red ball=12f → ratio 9/12=0.75 per player hop.
var EX_MOVE_RATE = {
    egg:       9 / 12,   // 0.75 — moves 3 times per 4 player hops
    coily:     9 / 12,   // 0.75
    redball:   9 / 12,   // 0.75
    ugg:       9 / 12,   // 0.75
    wrongway:  9 / 12,   // 0.75
    greenball: 9 / 15,   // 0.60
    slick:     9 / 17    // 0.53
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
        if (e.type === 'spawn-timer') {
            // Mark spawn positions as dangerous when timer will fire within ~2 player hops
            // Timer units differ: frames in HTML game, turns in test harness.
            // Estimate frames-per-hop to normalize.
            var sm = speedMultiplier();
            var fph = Math.ceil(1 / (0.111 * sm)) + Math.max(1, Math.round(2 / sm));
            var gs = (typeof gameSpeed !== 'undefined') ? gameSpeed : 1.0;
            var tickPerHop = fph * gs;
            // If timer > 100, it's frame-based (HTML); otherwise turn-based (test)
            var hopsUntil = e.timer > 20 ? Math.ceil(e.timer / tickPerHop) : e.timer;
            if (hopsUntil <= 2) {
                var ft = e.forcedType;
                if (ft === 'ugg') {
                    immediate[(ROWS-1) + ',' + (ROWS-1)] = true;
                } else if (ft === 'wrongway') {
                    immediate[(ROWS-1) + ',0'] = true;
                } else if (ft === 'egg' || !ft) {
                    immediate['0,0'] = true;
                } else if (ft === 'redball') {
                    immediate['1,0'] = true;
                    immediate['1,1'] = true;
                }
            }
            continue;
        }
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
            // Bottom-corners-first: mildly prioritize peripheral cubes when safe
            // These are hardest to revisit, so clear them early — but only
            // when no enemies are nearby (Ugg/Wrongway spawn at bottom)
            var isEdge = (tc2 === 0 || tc2 === tr);
            var isBottom = (tr >= ROWS - 2);
            if (!danger.immediate[tr + ',' + tc2]) {
                if (isBottom && isEdge) cost -= 2;
                else if (isBottom || isEdge) cost -= 1;
            }
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

// ─── Tour cost with connected-component awareness ────────────────────────────
// On revert levels, completed cubes act as barriers. Uncolored cubes form
// connected components. Strategy: finish current component, then cross to the
// nearest component (paying a crossing penalty per completed cube traversed).
var ALL_CUBES = (1 << POS_COUNT) - 1;  // all 28 bits set

// Find connected components of set bits in 'needs' using pyramid adjacency.
// Returns array of bitmasks, one per component.
function findComponents(needs) {
    var components = [];
    var remaining = needs;
    while (remaining !== 0) {
        // Pick any set bit as seed
        var seed = -1;
        for (var i = 0; i < POS_COUNT; i++) {
            if (remaining & (1 << i)) { seed = i; break; }
        }
        if (seed < 0) break;
        // BFS flood fill through 'needs' neighbors
        var comp = 1 << seed;
        var queue = [seed];
        remaining &= ~(1 << seed);
        while (queue.length > 0) {
            var cur = queue.shift();
            var adj = posAdj[cur];
            for (var a = 0; a < adj.length; a++) {
                var v = adj[a];
                if (remaining & (1 << v)) {
                    comp |= (1 << v);
                    remaining &= ~(1 << v);
                    queue.push(v);
                }
            }
        }
        components.push(comp);
    }
    return components;
}

// Greedy nearest-neighbor tour cost within a single component (no crossing penalty).
function intraComponentCost(startIdx, comp) {
    if (comp === 0) return 0;
    var pos = startIdx;
    var needs = comp;
    var totalCost = 0;
    while (needs !== 0) {
        var bestIdx = -1, bestDist = 99;
        for (var i = 0; i < POS_COUNT; i++) {
            if (!(needs & (1 << i))) continue;
            var d = distMatrix[pos * POS_COUNT + i];
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        if (bestIdx < 0) break;
        totalCost += bestDist;
        needs &= ~(1 << bestIdx);
        pos = bestIdx;
    }
    return { cost: totalCost, endIdx: pos };
}

// Minimum BFS distance from any cube in 'fromSet' to any cube in 'toSet',
// crossing through completed cubes. Returns {dist, crossings} where crossings
// is the number of completed cubes on the shortest path.
function crossingDistance(fromIdx, toComp, needs) {
    var bestDist = 99, bestCrossings = 0;
    // Find nearest cube in toComp from fromIdx, counting completed cubes crossed
    var visited = new Uint8Array(POS_COUNT);
    var distArr = new Uint8Array(POS_COUNT);
    var crossArr = new Uint8Array(POS_COUNT);
    visited[fromIdx] = 1;
    var queue = [fromIdx];
    while (queue.length > 0) {
        var cur = queue.shift();
        if (toComp & (1 << cur)) {
            return { dist: distArr[cur], crossings: crossArr[cur] };
        }
        var adj = posAdj[cur];
        for (var a = 0; a < adj.length; a++) {
            var v = adj[a];
            if (visited[v]) continue;
            visited[v] = 1;
            distArr[v] = distArr[cur] + 1;
            // Count completed cubes crossed (not in needs = completed)
            crossArr[v] = crossArr[cur] + ((needs & (1 << v)) ? 0 : 1);
            queue.push(v);
        }
    }
    return { dist: 99, crossings: 0 };
}

// Main tour cost function. On revert levels, uses component-aware planning.
// Non-revert levels use simple greedy nearest-neighbor.
function greedyTourCost(startIdx, needs, isRevert, lv) {
    if (needs === 0) return 0;

    if (!isRevert) {
        // Simple greedy nearest-neighbor (no crossing penalties)
        return intraComponentCost(startIdx, needs).cost;
    }

    var revertPenalty = (lv >= 5) ? 5 : 2;

    // Revert level: find connected components of uncolored cubes
    var components = findComponents(needs);
    if (components.length <= 1) {
        // Single component — just do greedy tour within it
        return intraComponentCost(startIdx, needs).cost;
    }

    // Multiple components — find which one we're in (or nearest to)
    var pos = startIdx;
    var totalCost = 0;
    var visited = 0; // bitmask of visited component indices

    while (visited !== (1 << components.length) - 1) {
        // Find nearest unvisited component
        var bestComp = -1, bestDist = 99, bestCross = 0;
        for (var ci = 0; ci < components.length; ci++) {
            if (visited & (1 << ci)) continue;
            // Are we already inside this component?
            if (components[ci] & (1 << pos)) {
                bestComp = ci; bestDist = 0; bestCross = 0;
                break;
            }
            var cd = crossingDistance(pos, components[ci], needs);
            if (cd.dist < bestDist) {
                bestDist = cd.dist; bestComp = ci; bestCross = cd.crossings;
            }
        }
        if (bestComp < 0) break;

        // Cost to reach this component (crossing completed cubes = reverts)
        totalCost += bestDist + bestCross * revertPenalty;

        // Cost to finish this component
        var intra = intraComponentCost(pos, components[bestComp]);
        totalCost += intra.cost;
        pos = intra.endIdx;
        visited |= (1 << bestComp);
    }
    return totalCost;
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
        var clone = { type: e.type, row: e.row, col: e.col, hops: e.hops, accum: e.accum };
        if (e.cloud) {
            clone.cloud = new Array(e.cloud.length);
            for (var j = 0; j < e.cloud.length; j++)
                clone.cloud[j] = { row: e.cloud[j].row, col: e.cloud[j].col, prob: e.cloud[j].prob };
        }
        ens.push(clone);
    }
    var ds = [];
    for (var i = 0; i < st.discs.length; i++)
        ds.push({ side: st.discs[i].side, row: st.discs[i].row, active: st.discs[i].active });
    var sp = null;
    if (st.spawns && st.spawns.length > 0) {
        sp = [];
        for (var i = 0; i < st.spawns.length; i++)
            sp.push({ timer: st.spawns[i].timer, forcedType: st.spawns[i].forcedType });
    }
    return { pr: st.pr, pc: st.pc, cubes: cs, enemies: ens,
             alive: st.alive, score: st.score, cubesColored: st.cubesColored, tgt: st.tgt,
             discs: ds, lv: st.lv, spawns: sp };
}

// ─── Probability-cloud enemy model ───────────────────────────────────────────
// Random enemies are tracked as probability distributions over positions.
// Each step, each position spawns 2 children at 50% (DL/DR for balls/eggs,
// UL/UR for ugg/wrongway). This gives O(N) positions after N steps, not 2^N.
// Coily is deterministic (greedy chase) — single position, no branching.

// Expand a random enemy's probability cloud by one step.
// Returns new array of {row, col, prob} entries (merged by position).
function expandCloud(cloud, type) {
    var merged = {};
    for (var i = 0; i < cloud.length; i++) {
        var c = cloud[i];
        var moves;
        if (type === 'egg' || type === 'redball' || type === 'slick' || type === 'greenball') {
            moves = [DIRS['DL'], DIRS['DR']];
        } else if (type === 'ugg') {
            // Arcade: Ugg moves UL (row-1,col-1) or Left (row,col-1)
            moves = [{dr:-1, dc:-1}, {dr:0, dc:-1}];
        } else { // wrongway
            // Arcade: Wrongway moves UR (row-1,col) or Right (row,col+1)
            moves = [{dr:-1, dc:0}, {dr:0, dc:1}];
        }
        for (var m = 0; m < 2; m++) {
            var nr = c.row + moves[m].dr, nc = c.col + moves[m].dc;
            if (isValidPos(nr, nc)) {
                var key = nr + ',' + nc;
                if (!merged[key]) merged[key] = { row: nr, col: nc, prob: 0 };
                merged[key].prob += c.prob * 0.5;
            }
            // If invalid, probability mass is lost (enemy fell off)
        }
    }
    var result = [];
    for (var key in merged) result.push(merged[key]);
    return result;
}

// Compute P(death) from enemy clouds at player position
function deathProb(st) {
    var pSurvive = 1.0;
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        // Slick/greenball don't kill — skip them
        if (e.type === 'slick' || e.type === 'greenball') continue;
        if (e.cloud) {
            // Random enemy — check probability mass at player pos
            for (var j = 0; j < e.cloud.length; j++) {
                if (e.cloud[j].row === st.pr && e.cloud[j].col === st.pc) {
                    pSurvive *= (1 - e.cloud[j].prob);
                }
            }
        } else {
            // Deterministic enemy (Coily) — certain death if overlapping
            if (e.row === st.pr && e.col === st.pc) return 1.0;
        }
    }
    return 1 - pSurvive;
}

// Move all enemies one step. Coily moves deterministically, random enemies
// expand their probability clouds.
function exMoveEnemies(st) {
    // Tick spawn timers — spawn enemies into the simulation
    // Timer is in "AI steps" (normalized by exCloneState), decrement by 1 per step.
    if (st.spawns) {
        for (var si = st.spawns.length - 1; si >= 0; si--) {
            st.spawns[si].timer--;
            if (st.spawns[si].timer <= 0) {
                var ft = st.spawns[si].forcedType;
                st.spawns.splice(si, 1);
                // Add spawned enemy to the state
                if (ft === 'ugg') {
                    st.enemies.push({ type: 'ugg', row: ROWS-1, col: ROWS-1, accum: 0,
                        cloud: [{ row: ROWS-1, col: ROWS-1, prob: 1.0 }] });
                } else if (ft === 'wrongway') {
                    st.enemies.push({ type: 'wrongway', row: ROWS-1, col: 0, accum: 0,
                        cloud: [{ row: ROWS-1, col: 0, prob: 1.0 }] });
                } else if (ft === 'egg' || !ft) {
                    // Egg spawns at (0,0)
                    st.enemies.push({ type: 'egg', row: 0, col: 0, hops: 0, accum: 0,
                        cloud: [{ row: 0, col: 0, prob: 1.0 }] });
                } else if (ft === 'redball') {
                    // Redball spawns at row 1 — model as cloud over both columns
                    st.enemies.push({ type: 'redball', row: 1, col: 0, accum: 0,
                        cloud: [{ row: 1, col: 0, prob: 0.5 }, { row: 1, col: 1, prob: 0.5 }] });
                } else if (ft === 'greenball') {
                    st.enemies.push({ type: 'greenball', row: 1, col: 0, accum: 0,
                        cloud: [{ row: 1, col: 0, prob: 0.5 }, { row: 1, col: 1, prob: 0.5 }] });
                }
            }
        }
    }
    for (var i = st.enemies.length - 1; i >= 0; i--) {
        var e = st.enemies[i];
        e.accum += EX_MOVE_RATE[e.type] || 0.75;
        if (e.accum < 1.0) continue;
        e.accum -= 1.0;

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
            // Egg: expand cloud, check if any position triggers hatch
            if (!e.cloud) e.cloud = [{ row: e.row, col: e.col, prob: 1.0 }];
            e.cloud = expandCloud(e.cloud, 'egg');
            e.hops++;
            if (e.hops >= 6) {
                // Hatch: pick highest-probability cloud position for Coily
                e.type = 'coily';
                if (e.cloud && e.cloud.length > 0) {
                    var bestP = 0, bestR = e.row, bestC = e.col;
                    for (var j = 0; j < e.cloud.length; j++) {
                        if (e.cloud[j].prob > bestP) {
                            bestP = e.cloud[j].prob;
                            bestR = e.cloud[j].row;
                            bestC = e.cloud[j].col;
                        }
                    }
                    e.row = bestR; e.col = bestC;
                }
                delete e.cloud;
            }
        } else if (e.cloud) {
            // Already a cloud — expand it
            e.cloud = expandCloud(e.cloud, e.type);
            if (e.cloud.length === 0) { st.enemies.splice(i, 1); continue; }
            // Slick/sam: probabilistically revert cubes they land on
            if (e.type === 'slick') {
                for (var j = 0; j < e.cloud.length; j++) {
                    var cp = e.cloud[j];
                    var cube = exCubeAt(st, cp.row, cp.col);
                    if (cube && cube.state > 0) {
                        // Expected reversion: reduce state by prob
                        var oldC = Math.min(cube.state, st.tgt);
                        cube.state = Math.max(0, Math.round(cube.state - cp.prob));
                        var newC = Math.min(cube.state, st.tgt);
                        st.cubesColored += newC - oldC;
                    }
                }
            }
        } else {
            // First move — convert to cloud
            e.cloud = [{ row: e.row, col: e.col, prob: 1.0 }];
            e.cloud = expandCloud(e.cloud, e.type);
            if (e.cloud.length === 0) { st.enemies.splice(i, 1); continue; }
        }
    }
}

// Check if Coily would be lured off the edge by a disc
function coilyLured(e, disc) {
    var targetR = disc.row - 1;
    var targetC = disc.side === 0 ? 0 : disc.row;
    var bestDir = null, bestDist = Infinity;
    for (var k = 0; k < 4; k++) {
        var dk = DIRS[DIR_KEYS[k]];
        var er = e.row + dk.dr, ec = e.col + dk.dc;
        var dd = Math.abs(targetR - er) + Math.abs(targetC - ec);
        if (dd < bestDist) { bestDist = dd; bestDir = { nr: er, nc: ec }; }
    }
    return bestDir && !isValidPos(bestDir.nr, bestDir.nc);
}

function exPlayerMove(st, dirKey) {
    if (!st.alive) return false;
    var d = DIRS[dirKey];
    var nr = st.pr + d.dr, nc = st.pc + d.dc;

    // Disc escape
    if (!isValidPos(nr, nc)) {
        for (var di = 0; di < st.discs.length; di++) {
            var disc = st.discs[di];
            if (!disc.active) continue;
            if ((disc.side === 0 && dirKey === 'UL' && st.pc === 0 && st.pr === disc.row) ||
                (disc.side === 1 && dirKey === 'UR' && st.pc === st.pr && st.pr === disc.row)) {
                disc.active = false;
                var survived = [];
                for (var i = 0; i < st.enemies.length; i++) {
                    var e = st.enemies[i];
                    if (e.type === 'coily' && coilyLured(e, disc)) {
                        st.score += 500;
                    } else {
                        survived.push(e);
                    }
                }
                st.enemies = survived;
                st.pr = 0; st.pc = 0;
                return true;
            }
        }
        st.alive = false; return false;
    }

    st.pr = nr; st.pc = nc;

    // Check for certain death at landing position (deterministic enemies like Coily)
    // In the real game, collision kills you even if the cube would complete the level
    for (var ei = 0; ei < st.enemies.length; ei++) {
        var en = st.enemies[ei];
        if (en.type === 'slick' || en.type === 'greenball') continue;
        if (!en.cloud && en.row === st.pr && en.col === st.pc) {
            st.alive = false;
            return false;
        }
    }

    // Check death probability from cloud-based enemies at landing position
    var pDeathLand = deathProb(st);

    // Color cube
    var cube = exCubeAt(st, nr, nc);
    if (cube) {
        var oldC = Math.min(cube.state, st.tgt);
        cube.state = nextCubeState(cube.state);
        var newC = Math.min(cube.state, st.tgt);
        st.cubesColored += newC - oldC;
        if (newC > oldC) st.score += (cube.state === st.tgt) ? 25 : 15;
    }
    if (st.cubesColored >= st.cubes.length * st.tgt) {
        st.score += EX_WIN; return true;
    }

    // Simulate enemy movement
    exMoveEnemies(st);

    // Check death probability after enemies move (they may land on us)
    var pDeathAfter = deathProb(st);

    // Combined death probability: survive both phases
    st.stepDeathProb = 1 - (1 - pDeathLand) * (1 - pDeathAfter);

    return true;
}

function exTourCost(st) {
    var lv = st.lv !== undefined ? st.lv : arcadeLevel();
    var needs = 0;
    for (var i = 0; i < st.cubes.length; i++) {
        if (st.cubes[i].state < st.tgt)
            needs |= (1 << posToIdx[st.cubes[i].row * ROWS + st.cubes[i].col]);
    }
    if (needs === 0) return 0;
    var base = greedyTourCost(posToIdx[st.pr * ROWS + st.pc], needs, lv >= 3, lv);
    // On cycling levels (lv>=5), add isolation penalty: each remaining cube
    // surrounded by completed cubes will require crossing (reverting) to reach.
    if (lv >= 5) {
        for (var i = 0; i < POS_COUNT; i++) {
            if (!(needs & (1 << i))) continue;
            var r = idxToPos[i][0], c = idxToPos[i][1];
            var completedAdj = 0, totalAdj = 0;
            for (var k = 0; k < 4; k++) {
                var dk = DIRS[DIR_KEYS[k]];
                var nr = r + dk.dr, nc = c + dk.dc;
                if (!isValidPos(nr, nc)) continue;
                totalAdj++;
                var nidx = posToIdx[nr * ROWS + nc];
                if (!(needs & (1 << nidx))) completedAdj++;
            }
            if (totalAdj > 0) base += completedAdj * 2;
        }
    }
    return base;
}

function exStateKey(st, depth) {
    var k = st.pr + ',' + st.pc + '|';
    for (var i = 0; i < st.cubes.length; i++) k += st.cubes[i].state;
    k += '|';
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        if (e.cloud) {
            // Cloud enemies: position is deterministic from type+hops+accum
            k += e.type[0] + 'h' + (e.hops || 0) + 'a' + e.accum.toFixed(2) + ';';
        } else {
            // Deterministic enemies (Coily): exact position matters
            k += e.type[0] + e.row + ',' + e.col + 'a' + e.accum.toFixed(2) + ';';
        }
    }
    k += '|' + depth + '|';
    for (var i = 0; i < st.discs.length; i++) k += st.discs[i].active ? 1 : 0;
    return k;
}

var exMemoTable = {};

function exLeafValue(st) {
    if (!st.alive) return EX_DEATH;
    if (st.cubesColored >= st.cubes.length * st.tgt) return EX_WIN;
    return -exTourCost(st);
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

    var bestVal = -Infinity;
    for (var k = 0; k < 4; k++) {
        if (!exCanMove(st, DIR_KEYS[k])) continue;
        var child = exClone(st);
        if (!exPlayerMove(child, DIR_KEYS[k])) {
            bestVal = Math.max(bestVal, EX_DEATH);
        } else {
            // Blend survival/death using this step's deathProb from clouds
            var pDeath = child.stepDeathProb || 0;
            var survive = expectimax(child, depth - 1);
            var val = (1 - pDeath) * survive + pDeath * EX_DEATH;
            bestVal = Math.max(bestVal, val);
        }
    }

    exMemoTable[key] = bestVal;
    return bestVal;
}

function expectimaxEval(dirKey) {
    var st = exCloneState();
    var nEnemies = st.enemies.length;
    // Deeper search for better survival. Memoization keeps it fast.
    var depth = nEnemies <= 1 ? 10 : nEnemies <= 2 ? 9 : nEnemies <= 4 ? 7 : 6;
    var lv = st.lv !== undefined ? st.lv : arcadeLevel();
    // Endgame on cycling levels: deeper
    if (lv >= 5) {
        var remaining = 0;
        for (var i = 0; i < st.cubes.length; i++)
            if (st.cubes[i].state < st.tgt) remaining++;
        if (remaining <= 3 && nEnemies === 0) depth = 12;
        else if (remaining <= 6 && nEnemies <= 1) depth = 11;
    }
    var child = exClone(st);
    if (!exPlayerMove(child, dirKey)) {
        return EX_DEATH + exLeafValue(st) * 0.0001;
    }
    var pDeath = child.stepDeathProb || 0;
    var val = (1 - pDeath) * expectimax(child, depth - 1) + pDeath * EX_DEATH;
    // Apply repeat penalty to the immediate next state (first move matters most)
    if (lv >= 3) {
        var bh = boardHash(child);
        var visits = aiBoardHistory[bh] || 0;
        if (visits > 0) val -= visits * AI_REPEAT_PENALTY;
    }
    return val + exLeafValue(st) * 0.0001;
}

// ─── Board-state repetition tracking ─────────────────────────────────────────
// Simple counter of how many times each board state has been seen.
// States that have been visited before get penalized in exLeafValue.
var aiBoardHistory = {};
var AI_REPEAT_PENALTY = 120;
var aiLastPos = '';  // last position for oscillation detection
var aiStuckCount = 0; // turns spent at same remaining count

function boardHash(st) {
    var h = st.pr + ',' + st.pc + '|';
    for (var i = 0; i < st.cubes.length; i++) h += st.cubes[i].state;
    return h;
}

function aiRecordState() {
    var st = exCloneState();
    var h = boardHash(st);
    aiBoardHistory[h] = (aiBoardHistory[h] || 0) + 1;
}

// ─── Precomputed optimal tours from (0,0) ────────────────────────────────────
// Computed offline via beam search. These are optimal (or near-optimal) move
// sequences for clearing all 28 cubes with no enemies present.
var PRECOMPUTED_TOURS = {
    // lv1 (tgt=1, simple): 32 moves
    1: ["DL","UR","DR","DR","DR","DR","DR","DR","UL","DL","UL","DL","UL","UR","UL","UL","DL","UL","DL","DL","DL","DL","UR","DR","UR","UR","DR","UR","DL","DL","UR","DR"],
    // lv2 (tgt=2, no revert): 64 moves
    2: ["DL","DL","UR","DL","DL","DL","UR","DL","DL","DL","UR","DL","UR","DR","UR","DL","UR","DR","UR","DL","UR","UL","UR","DL","UR","UR","DR","UL","DR","DL","DR","UL","DR","DR","UR","DL","UR","DR","UR","DL","UR","DR","UL","DR","UL","UL","UL","DR","UL","UL","UL","UL","DR","UL","DR","DR","DL","DR","DL","UR","DL","DL","UL","DR"],
    // lv3 (tgt=1, toggle 0→1→0): 36 moves (exact optimal via IDA*)
    3: ["DL","UR","DR","DL","DL","UL","DL","DL","UR","DL","DL","DL","UR","DR","UL","UR","UR","DR","DL","DR","UR","UR","DR","DL","UR","DR","UL","UR","UL","UR","DR","DR","DL","DR","UR","DR"],
    // lv4 (tgt=2, revert 2→1): 64 moves (SAT-optimal)
    4: ["DR","UL","DR","UL","DR","DR","DR","DR","DR","DR","UL","DL","UL","UL","UL","DL","UL","DL","DR","DR","UL","DL","UL","DL","UL","DL","UR","DL","UR","UR","UR","UR","UR","DR","DR","DR","DR","DR","UR","DR","UL","UL","UL","UL","UL","DL","UL","DL","DR","DR","DL","DL","UL","DL","UL","UR","UR","DR","DR","DR","UR","DR","UL","DR"],
    // lv5+ (tgt=2, cycling 0→1→2→0): 77 moves
    5: ["DL","UR","DL","UR","DR","DR","UL","DR","DR","DR","UL","DR","DR","DL","UR","DL","UL","DL","UR","DL","UL","UR","DL","UR","UL","UL","DR","UL","DL","UL","DL","UR","DR","DR","DL","UL","DR","UL","UL","DL","DL","UR","DL","DL","UR","DL","UR","DR","UL","DR","UR","DR","UL","DR","UR","UR","DL","DR","UL","DR","UR","UR","DL","UR","DL","UR","UR","DR","UL","DR","UL","DR","DR","DR","UL","DR","UL"]
};
var aiTourMoves = null;  // current tour move sequence (directions)
var aiTourStep = 0;      // current position in tour
var aiTourPositions = null; // tour as positions for resumption

// Convert direction sequence to position sequence starting from (0,0)
function tourToPositions(dirs) {
    var positions = [];
    var r = 0, c = 0;
    for (var i = 0; i < dirs.length; i++) {
        var d = DIRS[dirs[i]];
        r += d.dr; c += d.dc;
        positions.push({ row: r, col: c });
    }
    return positions;
}

function aiTourInit() {
    var lv = arcadeLevel();
    var tour;
    if (lv >= 5) tour = PRECOMPUTED_TOURS[5];
    else if (lv === 4) tour = PRECOMPUTED_TOURS[4];
    else if (lv === 3) tour = PRECOMPUTED_TOURS[3];
    else if (lv === 2) tour = PRECOMPUTED_TOURS[2];
    else tour = PRECOMPUTED_TOURS[1];
    aiTourMoves = tour;
    aiTourPositions = tourToPositions(tour);
    aiTourStep = 0;
}

function aiTourNext() {
    if (!aiTourMoves || aiTourStep >= aiTourMoves.length) return null;
    return aiTourMoves[aiTourStep++];
}

// Find the next uncolored position in the precomputed tour, starting from current tour step.
// Returns the BFS path (as direction keys) from current player position, or null.
function findTourResumePath() {
    if (!aiTourPositions) return null;
    var tgt = targetState();
    // Find the next uncolored cube in the precomputed tour order
    for (var i = aiTourStep; i < aiTourPositions.length; i++) {
        var tp = aiTourPositions[i];
        var cube = cubeAt(tp.row, tp.col);
        if (cube && cube.state < tgt) {
            // Found next target — BFS to it
            var res = bfsTo(player.row, player.col, tp.row, tp.col);
            if (res) {
                aiTourStep = i; // align tour step
                return res.path;
            }
        }
    }
    // All remaining tour positions are colored — tour is complete
    return null;
}

function hasNearbyDanger(st) {
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        if (e.type === 'slick' || e.type === 'greenball') continue;
        // Coily is deterministic and fast — detect at 3 hops
        // Random enemies — detect at 2 hops
        var threshold = (e.type === 'coily') ? 3 : 2;
        var dist = exBfsDist(st.pr, st.pc, e.row, e.col);
        if (dist <= threshold) return true;
        // Also check if enemy cloud has probability mass near player
        if (e.cloud) {
            for (var j = 0; j < e.cloud.length; j++) {
                if (e.cloud[j].prob > 0.1) {
                    var cd = exBfsDist(st.pr, st.pc, e.cloud[j].row, e.cloud[j].col);
                    if (cd <= threshold) return true;
                }
            }
        }
    }
    return false;
}

var aiResumePath = null; // BFS path to resume tour after dodging

function aiPickBestDir() {
    // Follow precomputed tour if available, on track, and safe
    if (aiTourMoves && aiTourStep < aiTourMoves.length) {
        var tmpSt = exCloneState();
        // Check for nearby danger — if so, drop to expectimax
        if (hasNearbyDanger(tmpSt)) {
            aiResumePath = null; // invalidate resume path during danger
            // Fall through to expectimax search
        } else {
            var tourDir = aiTourMoves[aiTourStep];
            // Check if we're at the expected position for this tour step
            var expectedPos = aiTourStep > 0 ? aiTourPositions[aiTourStep - 1] : { row: 0, col: 0 };
            var onTrack = (tmpSt.pr === expectedPos.row && tmpSt.pc === expectedPos.col);

            if (onTrack && exCanMove(tmpSt, tourDir)) {
                aiTourStep++;
                aiResumePath = null;
                return tourDir;
            }

            // Off track — try to resume by navigating to next uncolored tour position
            if (!aiResumePath || aiResumePath.length === 0) {
                aiResumePath = findTourResumePath();
            }
            if (aiResumePath && aiResumePath.length > 0) {
                var nextDir = aiResumePath.shift();
                // Safety: don't follow resume path onto an enemy
                if (exCanMove(tmpSt, nextDir) && isSafeMove(nextDir)) return nextDir;
                aiResumePath = null; // path blocked, fall through to expectimax
            }
        }
    }

    // Record current state before evaluating moves
    aiRecordState();

    exMemoTable = {};
    var tmpSt = exCloneState();
    var lv = tmpSt.lv !== undefined ? tmpSt.lv : arcadeLevel();
    var curPos = tmpSt.pr + ',' + tmpSt.pc;

    // Detect if stuck: same position as 2 turns ago = bouncing
    var blocked = '';
    if (lv >= 3 && aiLastPos !== '') {
        var bh = boardHash(tmpSt);
        var visits = aiBoardHistory[bh] || 0;
        if (visits >= 3) {
            // This exact board state has been seen 3+ times — block returning
            blocked = aiLastPos;
        }
    }

    var bestDir = null, bestVal = -Infinity;
    var safeDir = null, safeVal = -Infinity; // best move that doesn't land on an enemy
    var fallbackDir = null, fallbackVal = -Infinity;
    var scores = {};
    for (var k = 0; k < 4; k++) {
        if (!exCanMove(tmpSt, DIR_KEYS[k])) continue;
        var val = expectimaxEval(DIR_KEYS[k]);
        scores[DIR_KEYS[k]] = val;
        // Track fallback (best of all moves regardless of safety)
        if (val > fallbackVal) { fallbackVal = val; fallbackDir = DIR_KEYS[k]; }
        // Track best safe move (doesn't land directly on enemy)
        if (isSafeMove(DIR_KEYS[k]) && val > safeVal) {
            safeVal = val; safeDir = DIR_KEYS[k];
        }
        // Skip blocked direction (the position we keep returning to)
        if (blocked !== '') {
            var d = DIRS[DIR_KEYS[k]];
            var nr = tmpSt.pr + d.dr, nc = tmpSt.pc + d.dc;
            if (nr + ',' + nc === blocked) continue;
        }
        if (val > bestVal) { bestVal = val; bestDir = DIR_KEYS[k]; }
    }

    aiLastPos = curPos;
    aiLastScores = scores;
    // Prefer safe moves; only use unsafe move if ALL moves are unsafe (cornered)
    var chosen = bestDir || fallbackDir || 'DL';
    if (safeDir && !isSafeMove(chosen)) chosen = safeDir;
    return chosen;
}
var aiLastScores = {};

// Safety check: never move onto a position occupied by a lethal enemy
function isSafeMove(dirKey) {
    var d = DIRS[dirKey];
    var nr = player.row + d.dr, nc = player.col + d.dc;
    if (!isValidPos(nr, nc)) return true; // disc moves or falls are handled elsewhere
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer' || e.type === 'slick' || e.type === 'greenball') continue;
        if (e.row === nr && e.col === nc) return false;
    }
    return true;
}
