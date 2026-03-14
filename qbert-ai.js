// qbert-ai.js — Q*bert AI logic
// Requires: qbert.js loaded first (provides constants, board, simulation)
//
// Provides: aiPickBestDir() — main entry point for AI move selection
//
// Two-mode AI:
//   Mode 1 (no Coily): Tour planning + danger zone avoidance
//   Mode 2 (Coily alive): Monte Carlo simulation search
//
// The AI uses the SAME simulation code as the game (simStep from qbert.js).
// No separate collision model — what the AI predicts IS what the game does.

// ─── Tour planning ───────────────────────────────────────────────────────────

// How many stomps does a cube need to reach target state?
function stompsNeeded(cubeState, lv) {
    var tgt = (lv === 1 || lv === 3) ? 1 : 2;
    if (cubeState >= tgt) return 0;
    if (lv <= 2) return tgt - cubeState;
    if (lv === 3) return cubeState === 0 ? 1 : 0;
    if (lv === 4) return cubeState === 0 ? 2 : (cubeState === 1 ? 1 : 0);
    return cubeState === 0 ? 2 : (cubeState === 1 ? 1 : 0);
}

function revertPenalty(lv) {
    if (lv <= 2) return 0;
    if (lv <= 4) return 3;  // toggle: revert + re-stomp = 2 extra, plus detour cost
    return 4;               // cycle: revert to 0 + 2 re-stomps + detour
}

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
            var cost = 1 + ((completedMask & (1 << v)) ? penalty : 0);
            var newDist = dist[u] + cost;
            if (newDist < dist[v]) dist[v] = newDist;
        }
    }
    return dist;
}

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
        var uDists = distTable[u];
        for (var i = 0; i < n; i++) {
            if (inMST[i]) continue;
            var d = uDists[allNodes[i]];
            if (d < minEdge[i]) minEdge[i] = d;
        }
    }
    return total;
}

function mstTourCost(startIdx, cubes, tgt, lv) {
    var penalty = revertPenalty(lv);
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
    var allNodes = [startIdx].concat(nodes);
    var distTable = [];
    for (var i = 0; i < allNodes.length; i++)
        distTable.push(dijkstraWeighted(allNodes[i], completedMask, penalty));
    return mstFromDistTable(allNodes, distTable) + extraStomps;
}

// Tour cost from a simulation state
function simTourCost(gs) {
    return mstTourCost(posToIdx[gs.player.row * ROWS + gs.player.col], gs.cubes, gs.tgt, gs.lv);
}

// ─── Danger zone assessment ──────────────────────────────────────────────────

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

function buildDangerMaps() {
    var immediate = {}, predicted = {}, coilies = [];
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') {
            var sm = speedMultiplier();
            var fph = Math.ceil(1 / (0.028 * sm));
            var gs2 = (typeof gameSpeed !== 'undefined') ? gameSpeed : 1.0;
            var tickPerHop = fph * gs2;
            var hopsUntil = e.timer > 20 ? Math.ceil(e.timer / tickPerHop) : e.timer;
            if (hopsUntil <= 2) {
                var ft = e.forcedType;
                if (ft === 'ugg') immediate[(ROWS-1) + ',' + (ROWS-1)] = true;
                else if (ft === 'wrongway') immediate[(ROWS-1) + ',0'] = true;
                else if (ft === 'egg' || !ft) immediate['0,0'] = true;
                else if (ft === 'redball') { immediate['1,0'] = true; immediate['1,1'] = true; }
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

// Build danger set for Mode 1 (random walker avoidance)
function buildDangerSet() {
    var danger = {};
    var sm = (typeof speedMultiplier === 'function') ? speedMultiplier() : 1;
    var framesPerHop = Math.ceil(1 / (0.028 * sm));
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'slick' || e.type === 'greenball') continue;
        if (e.type === 'coily') continue;
        if (e.type === 'spawn-timer') {
            if (e.timer <= framesPerHop * 2) {
                danger['1,0'] = true;
                danger['1,1'] = true;
            }
            continue;
        }
        var pos = enemyEffectivePos(e);
        var er = pos.row, ec = pos.col;
        danger[er + ',' + ec] = true;
        if (e.type === 'egg' || e.type === 'redball') {
            if (isValidPos(er + 1, ec)) danger[(er + 1) + ',' + ec] = true;
            if (isValidPos(er + 1, ec + 1)) danger[(er + 1) + ',' + (ec + 1)] = true;
        }
        if (e.type === 'ugg') {
            if (isValidPos(er - 1, ec - 1)) danger[(er-1) + ',' + (ec-1)] = true;
            if (isValidPos(er, ec - 1)) danger[er + ',' + (ec-1)] = true;
        }
        if (e.type === 'wrongway') {
            if (isValidPos(er - 1, ec)) danger[(er-1) + ',' + ec] = true;
            if (isValidPos(er, ec + 1)) danger[er + ',' + (ec+1)] = true;
        }
    }
    return danger;
}

// ─── Tour greedy planner ─────────────────────────────────────────────────────
var aiTour = [], aiTourIdx = 0, aiBoardSig = '';
var aiDetailPath = [], aiTourDots = [];

function aiTourInit() {}
function aiTourNext() { return null; }
function findTourResumePath() { return null; }

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
    aiTour = tour;
    aiTourIdx = 0;
    aiBoardSig = boardSig();
}

// Dijkstra tour planner — nearest unfinished cube via weighted BFS
function dynamicTourMove(gs) {
    var lv = gs.lv;
    var tgt = gs.tgt;
    var completedSet = {};
    var unfinished = [];
    for (var i = 0; i < gs.cubes.length; i++) {
        var c = gs.cubes[i];
        if (c.state >= tgt) completedSet[c.row + ',' + c.col] = true;
        else unfinished.push({ row: c.row, col: c.col });
    }
    if (unfinished.length === 0) return null;

    var penalty = revertPenalty(lv);
    var startKey = gs.player.row + ',' + gs.player.col;
    var dist = {}; dist[startKey] = 0;
    var prev = {}; prev[startKey] = null;
    var pq = [{ row: gs.player.row, col: gs.player.col, cost: 0 }];
    var bestTarget = null, bestCost = Infinity;

    while (pq.length > 0) {
        var minIdx = 0;
        for (var qi = 1; qi < pq.length; qi++)
            if (pq[qi].cost < pq[minIdx].cost) minIdx = qi;
        var cur = pq[minIdx];
        pq.splice(minIdx, 1);
        var curKey = cur.row + ',' + cur.col;
        if (cur.cost > dist[curKey]) continue;

        if (curKey !== startKey) {
            for (var ui = 0; ui < unfinished.length; ui++) {
                if (unfinished[ui].row === cur.row && unfinished[ui].col === cur.col) {
                    if (cur.cost < bestCost) { bestCost = cur.cost; bestTarget = { row: cur.row, col: cur.col }; }
                    break;
                }
            }
        }
        if (bestTarget && cur.cost > bestCost) break;

        for (var k = 0; k < 4; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = cur.row + dk.dr, nc = cur.col + dk.dc;
            if (!isValidPos(nr, nc)) continue;
            var nk = nr + ',' + nc;
            var moveCost = 1 + (completedSet[nk] ? penalty : 0);
            var newCost = cur.cost + moveCost;
            if (dist[nk] === undefined || newCost < dist[nk]) {
                dist[nk] = newCost;
                prev[nk] = { row: cur.row, col: cur.col, dir: DIR_KEYS[k] };
                pq.push({ row: nr, col: nc, cost: newCost });
            }
        }
    }

    if (!bestTarget) return null;
    var path = [];
    var tk = bestTarget.row + ',' + bestTarget.col;
    while (prev[tk] && prev[tk].dir) {
        path.unshift(prev[tk].dir);
        tk = prev[tk].row + ',' + prev[tk].col;
    }
    return path.length > 0 ? path[0] : null;
}

// ─── Can-move check ──────────────────────────────────────────────────────────
function simCanMove(gs, dirKey) {
    if (dirKey === 'STAY') return true;
    var d = DIRS[dirKey];
    var nr = gs.player.row + d.dr, nc = gs.player.col + d.dc;
    if (isValidPos(nr, nc)) return true;
    for (var di = 0; di < gs.discs.length; di++) {
        var disc = gs.discs[di];
        if (!disc.active) continue;
        if (disc.side === 0 && dirKey === 'UL' && gs.player.col === 0 && gs.player.row === disc.row) return true;
        if (disc.side === 1 && dirKey === 'UR' && gs.player.col === gs.player.row && gs.player.row === disc.row) return true;
    }
    return false;
}

// ─── Disc lure evaluation ────────────────────────────────────────────────────

function coilyLured(coily, disc) {
    var exitRow = disc.row;
    var lureR = exitRow - 1;
    var lureC = disc.side === 0 ? 0 : exitRow;
    var bestDir = null, bestDist = Infinity;
    for (var k = 0; k < DIR_KEYS.length; k++) {
        var dk = DIRS[DIR_KEYS[k]];
        var nr = coily.row + dk.dr, nc = coily.col + dk.dc;
        var dist = Math.abs(exitRow - 1 - nr) + Math.abs(lureC - nc);
        if (dist < bestDist) { bestDist = dist; bestDir = { nr: nr, nc: nc }; }
    }
    return bestDir && !isValidPos(bestDir.nr, bestDir.nc);
}

function isSafeMove(dirKey) {
    var d = DIRS[dirKey];
    var nr = player.row + d.dr, nc = player.col + d.dc;
    if (!isValidPos(nr, nc)) return true;
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer' || e.type === 'slick' || e.type === 'greenball') continue;
        var pos = enemyEffectivePos(e);
        if (e.type === 'coily') {
            // Coily mid-jump landing tile is dangerous
            if (e.destRow != null && e.destRow === nr && e.destCol === nc) return false;
            // Check where Coily goes next (chases player's current pos)
            var cp = predictCoilyNext(pos.row, pos.col, player.row, player.col);
            if (cp.row === nr && cp.col === nc) return false;
        } else {
            if (pos.row === nr && pos.col === nc) return false;
        }
    }
    return true;
}

function evalDiscLure() {
    var coily = null;
    for (var i = 0; i < enemies.length; i++) {
        if (enemies[i].type === 'coily') {
            var pos = enemyEffectivePos(enemies[i]);
            coily = { row: pos.row, col: pos.col };
            break;
        }
    }
    if (!coily) return null;

    for (var di = 0; di < discs.length; di++) {
        var disc = discs[di];
        if (!disc.active) continue;
        var discRow = disc.row;
        var discCol = disc.side === 0 ? 0 : discRow;
        var discDir = disc.side === 0 ? 'UL' : 'UR';

        if (player.row === discRow && player.col === discCol) {
            if (coilyLured(coily, disc)) return discDir;
        }

        var pathToDisc = bfsTo(player.row, player.col, discRow, discCol);
        if (pathToDisc && pathToDisc.dist <= 2) {
            var simCoilyR = coily.row, simCoilyC = coily.col;
            for (var s = 0; s < pathToDisc.dist; s++) {
                var cp = predictCoilyNext(simCoilyR, simCoilyC, discRow, discCol);
                simCoilyR = cp.row; simCoilyC = cp.col;
            }
            if (coilyLured({ row: simCoilyR, col: simCoilyC }, disc)) {
                if (pathToDisc.path.length > 0 && isSafeMove(pathToDisc.path[0])) {
                    return pathToDisc.path[0];
                }
            }
        }
    }
    return null;
}

// ─── Mode 1: Tour planning + danger avoidance ────────────────────────────────
function mode1Pick(gs, dangerSet) {
    var tourDir = dynamicTourMove(gs);
    if (tourDir !== null) {
        var d = DIRS[tourDir];
        var nr = gs.player.row + d.dr, nc = gs.player.col + d.dc;
        if (!dangerSet[nr + ',' + nc]) return tourDir;
    }

    // Fallback: evaluate each direction with multiple samples to handle
    // random enemy movement (single simStep can be misleading)
    var bestDir = null, bestCost = Infinity;
    var bestUnsafeDir = null, bestUnsafeCost = Infinity;
    var SAMPLES = 4;

    for (var k = 0; k < DIR_KEYS.length; k++) {
        if (!simCanMove(gs, DIR_KEYS[k])) continue;
        var totalTC = 0, survived = 0;
        for (var s = 0; s < SAMPLES; s++) {
            var child = simDeepClone(gs);
            var alive = simStep(child, DIR_KEYS[k]);
            if (alive) { survived++; totalTC += simTourCost(child); }
        }
        if (survived === 0) continue;
        var tc = totalTC / survived;
        var d = DIRS[DIR_KEYS[k]];
        var nr = gs.player.row + d.dr, nc = gs.player.col + d.dc;

        if (dangerSet[nr + ',' + nc]) {
            if (tc < bestUnsafeCost) { bestUnsafeCost = tc; bestUnsafeDir = DIR_KEYS[k]; }
        } else {
            if (tc < bestCost) { bestCost = tc; bestDir = DIR_KEYS[k]; }
        }
    }

    if (bestDir) return bestDir;
    if (bestUnsafeDir) return bestUnsafeDir;
    for (var k = 0; k < DIR_KEYS.length; k++) {
        if (simCanMove(gs, DIR_KEYS[k])) return DIR_KEYS[k];
    }
    return 'STAY';
}

// ─── Mode 2: Monte Carlo search ─────────────────────────────────────────────
// For each candidate move, run N random simulations forward K steps.
// Pick the move with best survival rate, tiebreak on tour cost.

var AI_TIME_BUDGET = 8;
var MC_SAMPLES = 24;     // Monte Carlo samples per candidate move
var MC_DEPTH = 6;        // How many hops to simulate forward

function mode2Pick(gs) {
    // Disc lure first
    var lureDir = evalDiscLure();
    if (lureDir) return lureDir;

    var startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    var bestDir = null, bestSurv = -1, bestTC = Infinity;

    for (var k = 0; k < DIR_KEYS_WITH_STAY.length; k++) {
        var dir = DIR_KEYS_WITH_STAY[k];
        if (!simCanMove(gs, dir)) continue;

        var survived = 0;
        var totalTC = 0;
        var won = 0;

        for (var s = 0; s < MC_SAMPLES; s++) {
            var clone = simDeepClone(gs);
            var alive = simStep(clone, dir);
            if (!alive) continue;
            if (clone.levelWon) { survived++; won++; totalTC -= 1000; continue; }

            // Continue simulating forward with greedy AI moves
            for (var step = 1; step < MC_DEPTH; step++) {
                // Pick a reasonable move: avoid danger, make tour progress
                var bestStepDir = mcPickGreedy(clone);
                alive = simStep(clone, bestStepDir);
                if (!alive || clone.levelWon) break;
            }
            if (alive) {
                survived++;
                if (clone.levelWon) { won++; totalTC -= 1000; }
                else totalTC += simTourCost(clone);
            }
        }

        var survRate = survived / MC_SAMPLES;
        var avgTC = survived > 0 ? totalTC / survived : Infinity;

        if (survRate > bestSurv + 1e-9 ||
            (Math.abs(survRate - bestSurv) < 1e-9 && avgTC < bestTC)) {
            bestSurv = survRate;
            bestTC = avgTC;
            bestDir = dir;
        }

        // Time check
        var elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime;
        if (elapsed > AI_TIME_BUDGET) break;
    }

    if (!bestDir) {
        for (var k = 0; k < DIR_KEYS.length; k++)
            if (simCanMove(gs, DIR_KEYS[k])) return DIR_KEYS[k];
        return 'STAY';
    }
    return bestDir;
}

// Greedy move picker for MC rollouts: avoid enemies, make tour progress
function mcPickGreedy(gs) {
    var bestDir = 'STAY', bestScore = -Infinity;
    for (var k = 0; k < DIR_KEYS_WITH_STAY.length; k++) {
        var dir = DIR_KEYS_WITH_STAY[k];
        if (!simCanMove(gs, dir)) continue;
        var d = DIRS[dir];
        var nr = gs.player.row + d.dr, nc = gs.player.col + d.dc;
        if (dir !== 'STAY' && !isValidPos(nr, nc)) {
            // Disc escape — always good
            return dir;
        }
        var score = 0;
        // Avoid enemies — but Coily is deterministic so we can exploit
        // apex immunity: jumping TO a standing Coily's tile is safe (they swap)
        var danger = false;
        for (var ei = 0; ei < gs.enemies.length; ei++) {
            var e = gs.enemies[ei];
            if (e.type === 'spawn-timer' || e.type === 'slick' || e.type === 'greenball') continue;
            if (e.type === 'coily') {
                if (e.destRow != null) {
                    // Coily mid-jump: landing tile is dangerous
                    if (e.destRow === nr && e.destCol === nc) { danger = true; break; }
                }
                // Coily standing or mid-jump: check where it goes NEXT
                // Coily chases player's CURRENT pos (source), not destination
                var cer = e.destRow != null ? e.destRow : e.row;
                var cec = e.destCol != null ? e.destCol : e.col;
                var cp = predictCoilyNext(cer, cec, gs.player.row, gs.player.col);
                if (cp.row === nr && cp.col === nc) { danger = true; break; }
            } else {
                var er = e.row, ec = e.col;
                if (e.destRow != null) { er = e.destRow; ec = e.destCol; }
                if (er === nr && ec === nc) { danger = true; break; }
                if (e.type === 'egg' || e.type === 'redball') {
                    if (isValidPos(er + 1, ec) && er + 1 === nr && ec === nc) danger = true;
                    if (isValidPos(er + 1, ec + 1) && er + 1 === nr && ec + 1 === nc) danger = true;
                }
            }
        }
        if (danger) score -= 100;
        // Prefer unfinished cubes
        for (var ci = 0; ci < gs.cubes.length; ci++) {
            if (gs.cubes[ci].row === nr && gs.cubes[ci].col === nc && gs.cubes[ci].state < gs.tgt) {
                score += 10;
                break;
            }
        }
        // Prefer mobility (more neighbors)
        var neighbors = 0;
        for (var nk = 0; nk < 4; nk++) {
            var dk = DIRS[DIR_KEYS[nk]];
            if (isValidPos(nr + dk.dr, nc + dk.dc)) neighbors++;
        }
        score += neighbors;
        // STAY penalty
        if (dir === 'STAY') score -= 1;

        if (score > bestScore) { bestScore = score; bestDir = dir; }
    }
    return bestDir;
}

// ─── Main entry point ────────────────────────────────────────────────────────
function aiPickBestDir() {
    var coilyActive = false;
    var frozen = false;
    for (var i = 0; i < enemies.length; i++) {
        if (enemies[i].type === 'coily') coilyActive = true;
    }
    if (typeof freezeTimer !== 'undefined' && freezeTimer > 0) frozen = true;

    var gs = simCloneGameState();

    if (!coilyActive || frozen) {
        var dangerSet = buildDangerSet();
        return mode1Pick(gs, dangerSet);
    } else {
        return mode2Pick(gs);
    }
}
