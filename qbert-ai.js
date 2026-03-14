// qbert-ai.js — Shared AI logic for Q*bert dino game
// Used by both dino-qbert.html (via <script src>) and test-ai.js (via eval).
//
// Globals required from including file:
//   round, player, enemies, cubeStates, discs
//   aiTour, aiTourIdx, aiBoardSig
//
// Globals provided by this file:
//   ROWS, DIRS, DIR_KEYS, EX_MOVE_RATE, EX_DEATH, EX_WIN
//   All AI functions, BFS, tour planning, danger maps
//   aiPickBestDir() — main entry point for choosing AI direction
//   Board utility functions (isValidPos, arcadeLevel, targetState, etc.)
//
// exCloneState() must be defined by the including file (differs between game/test).

// ─── Core constants ──────────────────────────────────────────────────────────
var ROWS = 7;
var DIRS = { UL: {dr:-1, dc:-1}, UR: {dr:-1, dc:0}, DL: {dr:1, dc:0}, DR: {dr:1, dc:1}, STAY: {dr:0, dc:0} };
var DIR_KEYS = ['UL', 'UR', 'DL', 'DR'];
var DIR_KEYS_WITH_STAY = ['UL', 'UR', 'DL', 'DR', 'STAY'];

// Player hop = 36f (0.60s), enemy hop = 38f (0.63s) at 1x level 1.
// No AI idle delay — AI moves instantly on landing (like holding joystick).
// Ratio = player_frames / enemy_frames = how far enemy advances per player hop.
var EX_MOVE_RATE = {
    egg:       36 / 38,   // 0.95 — player slightly faster
    coily:     36 / 38,   // 0.95
    redball:   36 / 38,   // 0.95
    ugg:       36 / 38,   // 0.95
    wrongway:  36 / 38,   // 0.95
    greenball: 36 / 46,   // 0.78 — leisurely
    slick:     36 / 54    // 0.67 — slow
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

// Level-based speed progression (no gameSpeed factor).
function levelSpeed() {
    var lv = arcadeLevel();
    return Math.min(2.0, 1.0 + (lv - 1) * 0.2);
}
// Combined speed: level progression × user speed slider.
function speedMultiplier() {
    var gs = (typeof gameSpeed !== 'undefined') ? gameSpeed : 1.0;
    return levelSpeed() * gs;
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

// Arcade-accurate enemy availability per round
// Round 1-2 (1-1,1-2): Coily + Red Ball only
// Round 3 (1-3): Coily + Ugg + Wrongway (no red balls)
// Round 4 (1-4): Coily + Red Ball + Slick
// Round 5 (2-1): Coily + Red Ball + Ugg + Wrongway
// Round 6 (2-2): Coily + Ugg + Wrongway + Slick + Green Ball
// Round 7 (2-3): Coily + Red Ball + Green Ball + Slick
// Round 8+ (2-4+): All enemies
function hasRedBall() {
    if (round <= 2) return true;
    if (round === 3) return false;  // 1-3: replaced by Ugg/Wrongway
    if (round >= 8) return true;    // 2-4+: all enemies
    var sub = ((round - 1) % 4) + 1;
    return sub === 1 || sub === 3 || sub === 4; // odd sub-rounds + round 4
}
function hasUggWrongway() { return round >= 3; }
function hasSlick() { return round >= 4; }
function hasGreenBall() { return round >= 6; }

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
            var fph = Math.ceil(1 / (0.028 * sm));
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

// ─── MST-based tour cost heuristic with weighted traversal ───────────────────
// Uses weighted Dijkstra for inter-cube distances: stepping on a completed cube
// costs 1 (hop) + penalty (future fix cost). MST of these weighted distances
// captures the "residue" damage of walking through completed territory.
//
// h = MST(weighted distances, rooted at player)
//   + Σ 2 × max(0, stomps_needed(cube_i) - 1)
//
// MST covers first-visit travel (including traversal damage).
// Extra stomp sum covers revisit overhead for multi-stomp cubes.

// How many stomps does a cube need to reach target state?
function stompsNeeded(cubeState, lv) {
    var tgt = (lv === 1 || lv === 3) ? 1 : 2;
    if (cubeState >= tgt) return 0;
    if (lv <= 2) return tgt - cubeState;
    if (lv === 3) return cubeState === 0 ? 1 : 0;
    if (lv === 4) return cubeState === 0 ? 2 : (cubeState === 1 ? 1 : 0);
    // lv5+ cycling: 0 needs 2 stomps, 1 needs 1 stomp
    return cubeState === 0 ? 2 : (cubeState === 1 ? 1 : 0);
}

// Penalty for stepping on a completed cube (future fix cost).
// Lv1-2: 0 (no revert). Lv3-4: 1 stomp to fix. Lv5+: 2 stomps to fix.
function revertPenalty(lv) {
    if (lv <= 2) return 0;
    if (lv <= 4) return 1;
    return 2;
}

// Dijkstra from srcIdx with penalty for stepping on completed cubes.
// completedMask = bitmask of position indices that are at target state.
// penalty = extra cost per completed cube crossed.
// Returns array of weighted distances to all POS_COUNT positions.
function dijkstraWeighted(srcIdx, completedMask, penalty) {
    var dist = new Array(POS_COUNT);
    var visited = new Uint8Array(POS_COUNT);
    for (var i = 0; i < POS_COUNT; i++) dist[i] = 999;
    dist[srcIdx] = 0;

    for (var iter = 0; iter < POS_COUNT; iter++) {
        var u = -1, uDist = 999;
        for (var i = 0; i < POS_COUNT; i++) {
            if (!visited[i] && dist[i] < uDist) { uDist = dist[i]; u = i; }
        }
        if (u < 0) break;
        visited[u] = 1;

        var adj = posAdj[u];
        for (var a = 0; a < adj.length; a++) {
            var v = adj[a];
            if (visited[v]) continue;
            // Cost: 1 hop + penalty if stepping on a completed cube
            var cost = 1 + ((completedMask & (1 << v)) ? penalty : 0);
            var newDist = dist[u] + cost;
            if (newDist < dist[v]) dist[v] = newDist;
        }
    }
    return dist;
}

// MST using Prim's with a precomputed distance table.
// distTable[i] = array of distances from allNodes[i] to all POS_COUNT positions.
// Returns MST weight.
function mstFromDistTable(allNodes, distTable) {
    var n = allNodes.length;
    if (n === 0) return 0;

    var inMST = new Uint8Array(n);
    var minEdge = new Array(n);
    for (var i = 0; i < n; i++) minEdge[i] = 999;
    minEdge[0] = 0;
    var total = 0;

    for (var iter = 0; iter < n; iter++) {
        var u = -1, uCost = 999;
        for (var i = 0; i < n; i++) {
            if (!inMST[i] && minEdge[i] < uCost) { uCost = minEdge[i]; u = i; }
        }
        if (u < 0) break;
        inMST[u] = 1;
        total += uCost;

        // Update cheapest edges using u's distance table
        var uDists = distTable[u];
        for (var i = 0; i < n; i++) {
            if (inMST[i]) continue;
            var d = uDists[allNodes[i]];
            if (d < minEdge[i]) minEdge[i] = d;
        }
    }
    return total;
}

// Main tour cost: weighted MST + per-cube extra stomp overhead.
function mstTourCost(startIdx, cubes, tgt, lv) {
    var penalty = revertPenalty(lv);

    // Build completed mask and nodes-needing-work list
    var completedMask = 0;
    var nodes = [];
    var extraStomps = 0;
    for (var i = 0; i < cubes.length; i++) {
        var idx = posToIdx[cubes[i].row * ROWS + cubes[i].col];
        var s = stompsNeeded(cubes[i].state, lv);
        if (s > 0) {
            nodes.push(idx);
            extraStomps += 2 * (s - 1);
        } else {
            completedMask |= (1 << idx);
        }
    }
    if (nodes.length === 0) return 0;

    // On simple levels (no penalty), use precomputed BFS distances for speed
    if (penalty === 0) {
        var allNodes = [startIdx].concat(nodes);
        var distTable = [];
        for (var i = 0; i < allNodes.length; i++) {
            // Use precomputed distMatrix row as distance array
            var dists = new Array(POS_COUNT);
            var base = allNodes[i] * POS_COUNT;
            for (var j = 0; j < POS_COUNT; j++) dists[j] = distMatrix[base + j];
            distTable.push(dists);
        }
        return mstFromDistTable(allNodes, distTable) + extraStomps;
    }

    // Toggle/cycling levels: run Dijkstra from each node with traversal penalty
    var allNodes = [startIdx].concat(nodes);
    var distTable = [];
    for (var i = 0; i < allNodes.length; i++) {
        distTable.push(dijkstraWeighted(allNodes[i], completedMask, penalty));
    }
    return mstFromDistTable(allNodes, distTable) + extraStomps;
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
                    // Arcade: egg spawns at row 1 (not apex)
                    st.enemies.push({ type: 'egg', row: 1, col: 0, hops: 0, accum: 0,
                        cloud: [{ row: 1, col: 0, prob: 0.5 }, { row: 1, col: 1, prob: 0.5 }] });
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

    // STAY: player doesn't move, enemies still advance
    if (dirKey === 'STAY') {
        exMoveEnemies(st);
        st.stepDeathProb = deathProb(st);
        return true;
    }

    var d = DIRS[dirKey];
    var nr = st.pr + d.dr, nc = st.pc + d.dc;

    // Disc escape: matches arcade behavior — disc clears ALL enemies
    if (!isValidPos(nr, nc)) {
        for (var di = 0; di < st.discs.length; di++) {
            var disc = st.discs[di];
            if (!disc.active) continue;
            if ((disc.side === 0 && dirKey === 'UL' && st.pc === 0 && st.pr === disc.row) ||
                (disc.side === 1 && dirKey === 'UR' && st.pc === st.pr && st.pr === disc.row)) {
                disc.active = false;
                // Arcade: Coily only dies if greedy chase takes him off edge
                var exitRow = disc.row;
                var discSide = disc.side;
                var coilyDied = false;
                var survived = [];
                for (var i = 0; i < st.enemies.length; i++) {
                    var en = st.enemies[i];
                    if (en.type === 'coily') {
                        var bestDir = null, bestDist = Infinity;
                        for (var kk = 0; kk < DIR_KEYS.length; kk++) {
                            var dk = DIRS[DIR_KEYS[kk]];
                            var enr = en.row + dk.dr, enc = en.col + dk.dc;
                            var dd = Math.abs(exitRow - 1 - enr) + Math.abs((discSide === 0 ? 0 : exitRow) - enc);
                            if (dd < bestDist) { bestDist = dd; bestDir = { nr: enr, nc: enc }; }
                        }
                        if (bestDir && !isValidPos(bestDir.nr, bestDir.nc)) {
                            st.score += 500;
                            coilyDied = true;
                        } else {
                            survived.push(en);
                        }
                    } else {
                        survived.push(en);
                    }
                }
                // When Coily dies, all other enemies are also cleared
                st.enemies = coilyDied ? [] : survived;
                st.pr = 0; st.pc = 0;
                // Color the landing cube
                var cube = exCubeAt(st, 0, 0);
                if (cube) {
                    var oldC = Math.min(cube.state, st.tgt);
                    cube.state = nextCubeState(cube.state);
                    var newC = Math.min(cube.state, st.tgt);
                    st.cubesColored += newC - oldC;
                }
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
    return mstTourCost(posToIdx[st.pr * ROWS + st.pc], st.cubes, st.tgt, lv);
}


function exCanMove(st, dirKey) {
    if (dirKey === 'STAY') return true;
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

function searchStateKey(st, depth) {
    var k = st.pr + ',' + st.pc + '|';
    for (var i = 0; i < st.cubes.length; i++) k += st.cubes[i].state;
    k += '|';
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        if (e.cloud) {
            k += e.type[0] + 'h' + (e.hops || 0) + 'a' + e.accum.toFixed(2) + ';';
        } else {
            k += e.type[0] + e.row + ',' + e.col + 'a' + e.accum.toFixed(2) + ';';
        }
    }
    k += '|' + depth;
    for (var i = 0; i < st.discs.length; i++) k += st.discs[i].active ? 1 : 0;
    return k;
}

// Stubs for precomputed tours — no longer used, Dijkstra handles all levels.
// Keep function signatures since they're called from initRound/computeAIMove.
function aiTourInit() {}
function aiTourNext() { return null; }
function findTourResumePath() { return null; }

// Predict where Coily will move given it chases toward (targetR, targetC)
function predictCoilyNext(coilyR, coilyC, targetR, targetC) {
    var bestDir = null, bestDist = Infinity;
    for (var k = 0; k < 4; k++) {
        var dk = DIRS[DIR_KEYS[k]];
        var nr = coilyR + dk.dr, nc = coilyC + dk.dc;
        if (!isValidPos(nr, nc)) continue;
        var dist = Math.abs(targetR - nr) + Math.abs(targetC - nc);
        if (dist < bestDist) { bestDist = dist; bestDir = k; }
    }
    if (bestDir === null) return { row: coilyR, col: coilyC };
    var dd = DIRS[DIR_KEYS[bestDir]];
    return { row: coilyR + dd.dr, col: coilyC + dd.dc };
}


// ─── Two-mode AI ──────────────────────────────────────────────────────────────
// Mode 1 (no Coily): Pure tour planning. Random enemies (redballs, eggs, ugg,
//   wrongway) walk randomly — just avoid their DL/DR children (the 2 squares
//   they might land on next). No deep search needed.
// Mode 2 (Coily alive): Coily chases deterministically and needs multi-step
//   lookahead to avoid traps. Uses iterative-deepening search with memoization.
// Green ball freeze: treat as Mode 1 regardless (enemies can't move).

// Build set of positions that are "below" a lethal random walker.
// Each random walker goes DL or DR with 50% probability each turn.
// Standing in either of those squares = coin-flip death. Avoid them.
function buildDangerSet() {
    var danger = {};
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer' || e.type === 'slick' || e.type === 'greenball') continue;
        if (e.type === 'coily') continue; // handled by Mode 2 search
        // Current position is dangerous
        danger[e.row + ',' + e.col] = true;
        // DL/DR children for top-down walkers (egg, redball)
        if (e.type === 'egg' || e.type === 'redball') {
            var dl = (e.row + 1) + ',' + e.col;
            var dr = (e.row + 1) + ',' + (e.col + 1);
            if (isValidPos(e.row + 1, e.col)) danger[dl] = true;
            if (isValidPos(e.row + 1, e.col + 1)) danger[dr] = true;
        }
        // Ugg: moves UL (row-1,col-1) or Left (row,col-1)
        if (e.type === 'ugg') {
            if (isValidPos(e.row - 1, e.col - 1)) danger[(e.row-1) + ',' + (e.col-1)] = true;
            if (isValidPos(e.row, e.col - 1)) danger[e.row + ',' + (e.col-1)] = true;
        }
        // Wrongway: moves UR (row-1,col) or Right (row,col+1)
        if (e.type === 'wrongway') {
            if (isValidPos(e.row - 1, e.col)) danger[(e.row-1) + ',' + e.col] = true;
            if (isValidPos(e.row, e.col + 1)) danger[e.row + ',' + (e.col+1)] = true;
        }
    }
    return danger;
}

// Mode 1: pure tour planning with random-walker avoidance.
// Dijkstra picks the best first move toward nearest unfinished cube.
// If that move lands on a dangerous square, try alternatives.
function mode1Pick(st, dangerSet) {
    var tourDir = dynamicTourMove(st);
    if (tourDir !== null) {
        var d = DIRS[tourDir];
        var nr = st.pr + d.dr, nc = st.pc + d.dc;
        if (!dangerSet[nr + ',' + nc]) return tourDir;
    }

    // Dijkstra's pick is dangerous (or no unfinished cubes).
    // Compare all directions by MST tour cost, preferring safe squares.
    var bestDir = null, bestCost = Infinity;
    var bestUnsafeDir = null, bestUnsafeCost = Infinity;

    for (var k = 0; k < DIR_KEYS.length; k++) {
        if (!exCanMove(st, DIR_KEYS[k])) continue;
        var child = exClone(st);
        if (!exPlayerMove(child, DIR_KEYS[k])) continue;
        var tc = exTourCost(child);
        var d = DIRS[DIR_KEYS[k]];
        var nr = st.pr + d.dr, nc = st.pc + d.dc;

        if (dangerSet[nr + ',' + nc]) {
            if (tc < bestUnsafeCost) { bestUnsafeCost = tc; bestUnsafeDir = DIR_KEYS[k]; }
        } else {
            if (tc < bestCost) { bestCost = tc; bestDir = DIR_KEYS[k]; }
        }
    }

    return bestDir || bestUnsafeDir || 'DL';
}

// ─── Dijkstra tour planner ────────────────────────────────────────────────────
// Nearest-unfinished-cube via weighted BFS (Dijkstra). Works on all levels.
// On cycling levels, penalizes crossing completed cubes to avoid reverts.
// On simple levels, penalty=0 so it's just shortest-path to nearest target.

function dynamicTourMove(st) {
    var lv = st.lv !== undefined ? st.lv : arcadeLevel();

    // Build completed mask for weighted BFS
    var tgt = st.tgt;
    var completedSet = {};
    var unfinished = [];
    for (var i = 0; i < st.cubes.length; i++) {
        var c = st.cubes[i];
        if (c.state >= tgt) {
            completedSet[c.row + ',' + c.col] = true;
        } else {
            unfinished.push({ row: c.row, col: c.col, state: c.state });
        }
    }
    if (unfinished.length === 0) return null; // all done

    // Weighted BFS (Dijkstra) from current position: find nearest unfinished cube.
    // Crossing a completed cube adds the revert penalty to the path cost.
    var penalty = revertPenalty(lv);
    var startKey = st.pr + ',' + st.pc;
    var dist = {};
    dist[startKey] = 0;
    var prev = {};
    prev[startKey] = null;
    // Simple priority queue (array sorted by cost)
    var pq = [{ row: st.pr, col: st.pc, cost: 0 }];
    var bestTarget = null, bestCost = Infinity;

    while (pq.length > 0) {
        // Find min cost in queue
        var minIdx = 0;
        for (var qi = 1; qi < pq.length; qi++) {
            if (pq[qi].cost < pq[minIdx].cost) minIdx = qi;
        }
        var cur = pq[minIdx];
        pq.splice(minIdx, 1);
        var curKey = cur.row + ',' + cur.col;
        if (cur.cost > dist[curKey]) continue; // stale entry

        // Check if this is an unfinished cube
        if (curKey !== startKey) {
            for (var ui = 0; ui < unfinished.length; ui++) {
                if (unfinished[ui].row === cur.row && unfinished[ui].col === cur.col) {
                    if (cur.cost < bestCost) {
                        bestCost = cur.cost;
                        bestTarget = { row: cur.row, col: cur.col };
                    }
                    break;
                }
            }
        }
        // If we found a target and it's closer than anything else could be, stop
        if (bestTarget && cur.cost > bestCost) break;

        // Expand neighbors
        for (var k = 0; k < 4; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = cur.row + dk.dr, nc = cur.col + dk.dc;
            if (!isValidPos(nr, nc)) continue;
            var nk = nr + ',' + nc;
            // Cost: 1 base + penalty if crossing a completed cube
            var moveCost = 1 + (completedSet[nk] ? penalty : 0);
            var newCost = cur.cost + moveCost;
            if (dist[nk] === undefined || newCost < dist[nk]) {
                dist[nk] = newCost;
                prev[nk] = { row: cur.row, col: cur.col, dir: DIR_KEYS[k] };
                pq.push({ row: nr, col: nc, cost: newCost });
            }
        }
    }

    if (!bestTarget) return null; // no reachable unfinished cube

    // Reconstruct path and return first move
    var path = [];
    var tk = bestTarget.row + ',' + bestTarget.col;
    while (prev[tk] && prev[tk].dir) {
        path.unshift(prev[tk].dir);
        tk = prev[tk].row + ',' + prev[tk].col;
    }
    return path.length > 0 ? path[0] : null;
}


// ─── Unified search for Mode 2 (Coily active) ────────────────────────────────
// Maximizes P(survive), tiebreaks on tour cost. Combines old safe+survival
// into one: safe paths (pSurvive=1) naturally win, but we gracefully handle
// situations where no safe path exists without needing a separate fallback.
var searchMemo = {};

function unifiedSearch(st, depth) {
    if (!st.alive) return { pSurvive: 0, tourCost: Infinity };
    if (st.cubesColored >= st.cubes.length * st.tgt) {
        return { pSurvive: 1, tourCost: -1000 - depth };
    }
    if (depth === 0) {
        return { pSurvive: 1, tourCost: exTourCost(st) };
    }

    var key = searchStateKey(st, depth);
    if (searchMemo[key] !== undefined) return searchMemo[key];

    var dirs = DIR_KEYS_WITH_STAY;
    var bestSurv = 0, bestTC = Infinity;

    for (var k = 0; k < dirs.length; k++) {
        if (!exCanMove(st, dirs[k])) continue;
        var child = exClone(st);
        if (!exPlayerMove(child, dirs[k])) continue;
        var stepSurvive = 1 - (child.stepDeathProb || 0);
        if (stepSurvive <= 0) continue;

        var sub = unifiedSearch(child, depth - 1);
        var totalSurv = stepSurvive * sub.pSurvive;
        var tc = sub.tourCost;
        if (dirs[k] === 'STAY') tc += 0.5;

        if (totalSurv > bestSurv + 1e-9 ||
            (Math.abs(totalSurv - bestSurv) < 1e-9 && tc < bestTC)) {
            bestSurv = totalSurv;
            bestTC = tc;
        }
    }

    var result = { pSurvive: bestSurv, tourCost: bestTC };
    searchMemo[key] = result;
    return result;
}

var AI_TIME_BUDGET = 8; // ms — must fit within a single 16.7ms frame

// Mode 2: Coily evasion with iterative-deepening search.
// First checks disc lure opportunity (kill Coily = best outcome).
// Then runs unified search to find the move that maximizes survival
// while making tour progress.
function mode2Pick(st) {
    // Check disc lure first — killing Coily is always the priority
    var lureDir = evalDiscLure();
    if (lureDir) return lureDir;

    var startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    var bestDir = null, bestSurv = -1, bestTC = Infinity;

    for (var depth = 1; depth <= 8; depth++) {
        searchMemo = {};
        var depthBestDir = null, depthBestSurv = -1, depthBestTC = Infinity;

        for (var k = 0; k < DIR_KEYS_WITH_STAY.length; k++) {
            if (!exCanMove(st, DIR_KEYS_WITH_STAY[k])) continue;
            var child = exClone(st);
            if (!exPlayerMove(child, DIR_KEYS_WITH_STAY[k])) continue;
            var stepSurvive = 1 - (child.stepDeathProb || 0);
            if (stepSurvive <= 0) continue;

            var sub = unifiedSearch(child, depth - 1);
            var totalSurv = stepSurvive * sub.pSurvive;
            var tc = sub.tourCost;
            if (DIR_KEYS_WITH_STAY[k] === 'STAY') tc += 0.5;

            if (totalSurv > depthBestSurv + 1e-9 ||
                (Math.abs(totalSurv - depthBestSurv) < 1e-9 && tc < depthBestTC)) {
                depthBestSurv = totalSurv;
                depthBestTC = tc;
                depthBestDir = DIR_KEYS_WITH_STAY[k];
            }
        }

        if (depthBestDir !== null) {
            bestDir = depthBestDir;
            bestSurv = depthBestSurv;
            bestTC = depthBestTC;
        }

        var elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime;
        if (elapsed > AI_TIME_BUDGET) break;
    }

    return bestDir || 'DL';
}

function aiPickBestDir() {
    // Check if Coily is alive
    var coilyActive = false;
    var frozen = false;
    for (var i = 0; i < enemies.length; i++) {
        if (enemies[i].type === 'coily') coilyActive = true;
    }
    // Check for freeze (green ball) — if frozen, enemies can't move, pure Mode 1
    if (typeof freezeTimer !== 'undefined' && freezeTimer > 0) frozen = true;

    var st = exCloneState();

    if (!coilyActive || frozen) {
        // Mode 1: no Coily (or frozen) — pure tour planning + avoid random walkers
        var dangerSet = buildDangerSet();
        return mode1Pick(st, dangerSet);
    } else {
        // Mode 2: Coily active — multi-step search for evasion + progress
        return mode2Pick(st);
    }
}

// Safety check: never move onto a position occupied by a lethal enemy,
// and also check Coily's predicted next position (since Coily might move
// onto us right after we land).
function isSafeMove(dirKey) {
    var d = DIRS[dirKey];
    var nr = player.row + d.dr, nc = player.col + d.dc;
    if (!isValidPos(nr, nc)) return true; // disc moves or falls are handled elsewhere
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer' || e.type === 'slick' || e.type === 'greenball') continue;
        // Current enemy position
        if (e.row === nr && e.col === nc) return false;
        // Coily's predicted next position (Coily chases toward our landing spot)
        if (e.type === 'coily') {
            var cp = predictCoilyNext(e.row, e.col, nr, nc);
            if (cp.row === nr && cp.col === nc) return false;
        }
    }
    return true;
}

// Evaluate whether using a disc to lure Coily off the edge is beneficial.
// Returns the direction to move to reach a disc, or null if not worthwhile.
function evalDiscLure() {
    var coily = null;
    for (var i = 0; i < enemies.length; i++) {
        if (enemies[i].type === 'coily') { coily = enemies[i]; break; }
    }
    if (!coily) return null;

    // Check each active disc
    for (var di = 0; di < discs.length; di++) {
        var disc = discs[di];
        if (!disc.active) continue;

        // Can we reach the disc position? Player must be on the disc's row,
        // at the correct edge column
        var discRow = disc.row;
        var discCol = disc.side === 0 ? 0 : discRow;
        var discDir = disc.side === 0 ? 'UL' : 'UR';

        // Check if player is already at disc position
        if (player.row === discRow && player.col === discCol) {
            // Would Coily actually be lured off?
            if (coilyLured(coily, disc)) {
                return discDir;
            }
        }

        // Check if we can reach the disc within 2 hops and Coily would be lured
        var pathToDisc = bfsTo(player.row, player.col, discRow, discCol);
        if (pathToDisc && pathToDisc.dist <= 2) {
            // Simulate Coily chasing us to the disc position
            var simCoilyR = coily.row, simCoilyC = coily.col;
            for (var s = 0; s < pathToDisc.dist; s++) {
                var cp = predictCoilyNext(simCoilyR, simCoilyC, discRow, discCol);
                simCoilyR = cp.row; simCoilyC = cp.col;
            }
            var simCoily = { row: simCoilyR, col: simCoilyC };
            if (coilyLured(simCoily, disc)) {
                // Check if the path to disc is safe
                var safe = true;
                if (pathToDisc.path.length > 0 && !isSafeMove(pathToDisc.path[0])) safe = false;
                if (safe) return pathToDisc.path[0];
            }
        }
    }
    return null;
}
