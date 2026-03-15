// qbert-ai.js — Q*bert AI logic  (v2 — oscillation fix + revert penalty)
var AI_VERSION = 'v4-freeze-aware';
// Requires: qbert.js loaded first (provides constants, board, simulation)
//
// Provides: aiPickBestDir() — main entry point for AI move selection
//
// Unified AI: always tour-plan, validate safety via simulation.
// No mode switching — Coily just means more safety samples.
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

function revertPenalty(lv, cubes, tgt) {
    if (lv <= 2) return 0;
    var basePenalty;
    if (lv === 3) basePenalty = 6;       // toggle: stepping on completed cube undoes work
    else if (lv === 4) basePenalty = 5;  // 2-step cycle: revert + re-stomp
    else basePenalty = 6;                // 3-step cycle: revert to 0 + 2 re-stomps

    // Scale penalty down when few cubes remain — crossing completed cubes
    // is worth it to reach the last few unfinished ones instead of long detours
    if (cubes) {
        var total = cubes.length;
        var remaining = 0;
        for (var i = 0; i < total; i++)
            if (cubes[i].state < (tgt || 1)) remaining++;
        // Scale linearly: at 5+ remaining full penalty, at 1 remaining penalty=1
        if (remaining <= 5) basePenalty = Math.max(1, Math.round(basePenalty * remaining / 5));
    }
    return basePenalty;
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
    var penalty = revertPenalty(lv, cubes, tgt);
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
            var tickPerHop = fph;
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
        var pos = enemyEffectivePos(e);
        immediate[pos.row + ',' + pos.col] = true;
        for (var k = 0; k < DIR_KEYS.length; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = pos.row + dk.dr, nc = pos.col + dk.dc;
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
                var ft = e.forcedType;
                if (ft === 'ugg') danger[(ROWS-1) + ',' + (ROWS-1)] = true;
                else if (ft === 'wrongway') danger[(ROWS-1) + ',0'] = true;
                else { danger['1,0'] = true; danger['1,1'] = true; }
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

function aiTourInit() { aiLastRemaining = 99; aiNoProgressCount = 0; aiStayCount = 0; aiSamePosCount = 0; aiPosHistory = []; }
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
            var isCorner = (tr === ROWS - 1 && isEdge);
            if (!danger.immediate[tr + ',' + tc2]) {
                if (isCorner) cost -= 4;
                else if (isBottom && isEdge) cost -= 3;
                else if (isBottom || isEdge) cost -= 1.5;
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

    var penalty = revertPenalty(lv, gs.cubes, tgt);
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
                    // Discount corners and bottom — clear them first while safe
                    var adjCost = cur.cost;
                    var isCorner = (cur.row === ROWS - 1 && (cur.col === 0 || cur.col === ROWS - 1));
                    var isBottom = cur.row >= ROWS - 2;
                    var isEdge = cur.col === 0 || cur.col === cur.row;
                    if (isCorner) adjCost -= 2;
                    else if (isBottom && isEdge) adjCost -= 1.5;
                    else if (isBottom || isEdge) adjCost -= 0.5;
                    if (adjCost < bestCost) { bestCost = adjCost; bestTarget = { row: cur.row, col: cur.col }; }
                    break;
                }
            }
        }
        if (bestTarget && cur.cost > bestCost + 2) break;

        for (var k = 0; k < 4; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = cur.row + dk.dr, nc = cur.col + dk.dc;
            if (!isValidPos(nr, nc)) continue;
            var nk = nr + ',' + nc;
            var moveCost = 1 + (completedSet[nk] ? penalty : 0);
            // Extra cost for completed apex and corners — dead ends with revert risk
            if (completedSet[nk]) {
                var isApex = (nr === 0 && nc === 0);
                var isCrnr = (nr === ROWS - 1 && (nc === 0 || nc === ROWS - 1));
                if (isApex || isCrnr) moveCost += 3;
            }
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
            // Coily's current position is dangerous
            if (pos.row === nr && pos.col === nc) return false;
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

    var lv = arcadeLevel();

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
        // Path toward disc for lure — but not too far, safety degrades over distance
        // Level 5+: travel farther to lure Coily — peaceful windows are critical
        var maxLureDist = lv >= 5 ? 6 : (lv >= 3 ? 4 : 3);
        if (pathToDisc && pathToDisc.dist <= maxLureDist) {
            // Verify the whole path is safe from Coily interception
            var simCoilyR = coily.row, simCoilyC = coily.col;
            var pathSafe = true;
            var pr = player.row, pc = player.col;
            for (var s = 0; s < pathToDisc.dist; s++) {
                var dk = DIRS[pathToDisc.path[s]];
                pr += dk.dr; pc += dk.dc;
                // Coily chases player toward disc
                var cp = predictCoilyNext(simCoilyR, simCoilyC, pr, pc);
                // Check if Coily lands on or passes through our position
                if ((cp.row === pr && cp.col === pc) ||
                    (simCoilyR === pr && simCoilyC === pc)) {
                    pathSafe = false; break;
                }
                simCoilyR = cp.row; simCoilyC = cp.col;
            }
            if (pathSafe && coilyLured({ row: simCoilyR, col: simCoilyC }, disc)) {
                if (pathToDisc.path.length > 0 && isSafeMove(pathToDisc.path[0])) {
                    return pathToDisc.path[0];
                }
            }
        }
    }
    return null;
}

// ─── Unified pick: tour planning + simulation-validated safety ───────────────
// Always plans toward unfinished cubes. Validates each candidate via simulation.
// More samples when enemies are present for reliable safety checking.

function unifiedPick(gs, coilyActive) {
    // Use separate seeded RNG so AI simulations don't pollute game's Math.random.
    var savedRng = simRng;
    var baseSeed = (gs.player.row * 7 + gs.player.col) * 10000 + (frameCount || 0);
    function simSeed(sampleIdx) { simRng = createSeededRng(baseSeed + sampleIdx * 9973); }
    function restoreRng() { simRng = savedRng; }

    // ── Freeze mode: skip expensive avoidance but still validate via simulation ──
    // Only skip danger maps / Coily scoring if freeze lasts long enough.
    var jumpFrames = Math.ceil(1.0 / (gs.player.jumpDur || 0.028));
    var freezeSafeMargin = jumpFrames + 10;
    if (gs.freezeTimer > freezeSafeMargin) {
        // Build set of tiles where enemies will spawn during freeze
        var freezeSpawnDanger = {};
        for (var fsi = 0; fsi < gs.enemies.length; fsi++) {
            var fse = gs.enemies[fsi];
            if (fse.type !== 'spawn-timer') continue;
            if (fse.timer <= gs.freezeTimer) {
                // This enemy will spawn while still frozen
                var ft = fse.forcedType;
                if (ft === 'ugg') freezeSpawnDanger[(ROWS-1) + ',' + (ROWS-1)] = true;
                else if (ft === 'wrongway') freezeSpawnDanger[(ROWS-1) + ',0'] = true;
                else { freezeSpawnDanger['1,0'] = true; freezeSpawnDanger['1,1'] = true; }
            }
        }
        // Also mark positions of frozen enemies
        for (var fei = 0; fei < gs.enemies.length; fei++) {
            var fee = gs.enemies[fei];
            if (fee.type === 'spawn-timer' || fee.type === 'greenball' || fee.type === 'slick') continue;
            var fep = enemyEffectivePos(fee);
            freezeSpawnDanger[fep.row + ',' + fep.col] = true;
            // Also mark source tile for mid-jump enemies
            if (fee.jumping) freezeSpawnDanger[fee.row + ',' + fee.col] = true;
        }

        // Follow tour planner, but validate via simulation + spawn avoidance
        var tourDir = dynamicTourMove(gs);
        if (tourDir && simCanMove(gs, tourDir)) {
            var ttd = DIRS[tourDir];
            var ttr = gs.player.row + ttd.dr, ttc = gs.player.col + ttd.dc;
            if (!freezeSpawnDanger[ttr + ',' + ttc]) {
                var tc = simDeepClone(gs);
                if (simStep(tc, tourDir)) { restoreRng(); return tourDir; }
            }
        }
        // Fallback: pick best surviving tour-cost direction avoiding spawn danger
        var bestFD = null, bestFC = Infinity;
        for (var fk = 0; fk < DIR_KEYS.length; fk++) {
            var fd = DIR_KEYS[fk];
            if (!simCanMove(gs, fd)) continue;
            var fdd = DIRS[fd];
            var fnr = gs.player.row + fdd.dr, fnc = gs.player.col + fdd.dc;
            if (!isValidPos(fnr, fnc)) continue;
            if (freezeSpawnDanger[fnr + ',' + fnc]) continue;
            var fc = simDeepClone(gs);
            if (simStep(fc, fd)) {
                var ftc = fc.levelWon ? -1000 : simTourCost(fc);
                if (ftc < bestFC) { bestFC = ftc; bestFD = fd; }
            }
        }
        if (bestFD) { restoreRng(); return bestFD; }
    }

    var dangerSet = buildDangerSet();  // non-Coily enemy danger zones
    // More simulation samples when enemies could kill us
    var hasEnemies = gs.enemies.length > 0;
    var SAMPLES = coilyActive ? 24 : (hasEnemies ? 16 : 4);

    // Find Coily position for proximity-aware scoring
    var coilyR = -1, coilyC = -1;
    if (coilyActive) {
        for (var ci = 0; ci < gs.enemies.length; ci++) {
            var ce = gs.enemies[ci];
            if (ce.type === 'coily') {
                var cp = enemyEffectivePos(ce);
                coilyR = cp.row; coilyC = cp.col; break;
            }
            if (ce.type === 'egg' && (ce.willHatch || (ce.hops || 0) >= 5)) {
                var ep = enemyEffectivePos(ce);
                coilyR = ep.row; coilyC = ep.col; break;
            }
        }
    }

    // Disc lure — use it if Coily is active and the lure move is safe
    if (coilyActive) {
        var lureDir = evalDiscLure();
        if (lureDir) {
            var lureSafe = 0;
            for (var ls = 0; ls < SAMPLES; ls++) {
                simSeed(ls);
                var lc = simDeepClone(gs);
                if (simStep(lc, lureDir)) lureSafe++;
            }
            if (lureSafe === SAMPLES) { restoreRng(); return lureDir; }
        }
    }

    // Evaluate all directions: simulate for survival + tour cost
    var bestSafeDir = null, bestSafeCost = Infinity;
    var bestUnsafeDir = null, bestUnsafeCost = Infinity;
    var bestAnyDir = null, bestAnySurv = -1, bestAnyCost = Infinity;

    for (var k = 0; k < DIR_KEYS_WITH_STAY.length; k++) {
        var dir = DIR_KEYS_WITH_STAY[k];
        if (!simCanMove(gs, dir)) continue;

        // Don't waste discs when there's no Coily to escape from
        if (!coilyActive && dir !== 'STAY') {
            var dd = DIRS[dir];
            var dnr = gs.player.row + dd.dr, dnc = gs.player.col + dd.dc;
            if (!isValidPos(dnr, dnc)) continue;  // off-grid = disc move
        }

        var totalTC = 0, survived = 0;
        for (var s = 0; s < SAMPLES; s++) {
            simSeed(k * 100 + s);
            var child = simDeepClone(gs);
            var alive = simStep(child, dir);
            if (alive) {
                survived++;
                if (child.levelWon) totalTC -= 1000;
                else totalTC += simTourCost(child);
            }
        }

        var survRate = survived / SAMPLES;
        var avgTC = survived > 0 ? totalTC / survived : Infinity;

        // STAY penalty — it makes no tour progress
        // But reduce penalty when Coily is close: waiting lets Coily pass
        if (dir === 'STAY') {
            if (coilyR >= 0) {
                var stayDist = Math.abs(coilyR - gs.player.row) + Math.abs(coilyC - gs.player.col);
                if (stayDist <= 2) avgTC += 0;       // Coily very close — stay is free
                else if (stayDist <= 3) avgTC += 1;   // Coily nearby — small penalty
                else avgTC += 3;
            } else {
                avgTC += 3;
            }
        }

        // Bonus/penalty for what we land on
        if (dir !== 'STAY') {
            var d = DIRS[dir];
            var nr = gs.player.row + d.dr, nc = gs.player.col + d.dc;
            if (isValidPos(nr, nc)) {
                for (var ci2 = 0; ci2 < gs.cubes.length; ci2++) {
                    if (gs.cubes[ci2].row === nr && gs.cubes[ci2].col === nc) {
                        if (gs.cubes[ci2].state < gs.tgt) {
                            avgTC -= 8;
                            var isCorner = (nr === ROWS - 1 && (nc === 0 || nc === ROWS - 1));
                            var isBottom = nr >= ROWS - 2;
                            var isEdge = nc === 0 || nc === nr;
                            if (isCorner) avgTC -= 4;
                            else if (isBottom && isEdge) avgTC -= 3;
                            else if (isBottom || isEdge) avgTC -= 1;
                        } else if (gs.lv >= 3) {
                            // Penalty for stepping on completed cube (reverts it)
                            // Scale down when few cubes remain — crossing is worth it vs long detours
                            var unfCount = 0;
                            for (var uc = 0; uc < gs.cubes.length; uc++)
                                if (gs.cubes[uc].state < gs.tgt) unfCount++;
                            var revertPen = unfCount <= 3 ? 1 : (unfCount <= 5 ? 2 : 4);
                            avgTC += revertPen;
                            var isApex3 = (nr === 0 && nc === 0);
                            var isCrnr3 = (nr === ROWS - 1 && (nc === 0 || nc === ROWS - 1));
                            if (isApex3 || isCrnr3) avgTC += revertPen;  // extra for dead-ends
                        }
                        break;
                    }
                }
                // Coily proximity penalty: prefer moves that increase distance from Coily
                if (coilyR >= 0) {
                    var curDist = Math.abs(coilyR - gs.player.row) + Math.abs(coilyC - gs.player.col);
                    var newDist = Math.abs(coilyR - nr) + Math.abs(coilyC - nc);
                    if (newDist < curDist) avgTC += 6;  // moving toward Coily
                    else if (newDist > curDist) avgTC -= 3;  // moving away from Coily
                    // Extra penalty for getting very close
                    if (newDist <= 1) avgTC += 8;
                    else if (newDist <= 2) avgTC += 3;
                    // Escape route bonus: prefer tiles with more valid exits
                    var exits = 0;
                    for (var ek = 0; ek < DIR_KEYS.length; ek++) {
                        var edk = DIRS[DIR_KEYS[ek]];
                        if (isValidPos(nr + edk.dr, nc + edk.dc)) exits++;
                    }
                    if (exits <= 1) avgTC += 6;  // dead-end penalty
                    else if (exits <= 2) avgTC += 2;  // limited options
                }
                // Bonus for catching green balls and slicks
                for (var ei = 0; ei < gs.enemies.length; ei++) {
                    var e = gs.enemies[ei];
                    if (e.type === 'greenball' || e.type === 'slick') {
                        var er = e.destRow != null ? e.destRow : e.row;
                        var ec = e.destCol != null ? e.destCol : e.col;
                        if (er === nr && ec === nc) {
                            // Slicks are worth more on revert levels — catching saves re-work
                            avgTC -= (e.type === 'greenball') ? 15 : (gs.lv >= 3 ? 20 : 8);
                        }
                        // Intercept bonus: if slick is 1 hop from this tile, moving here may catch it next turn
                        if (e.type === 'slick' && gs.lv >= 3) {
                            var slickDist = Math.abs(er - nr) + Math.abs(ec - nc);
                            if (slickDist === 1) avgTC -= 6;
                        }
                    }
                }
            }
        }

        // Export for viz
        if (survived === 0) {
            aiMoveScores[dir] = -10000;
        } else if (survRate >= 1) {
            aiMoveScores[dir] = 10000 - avgTC;
        } else {
            aiMoveScores[dir] = survRate * 100 - 100;
        }

        // Track best options by category
        var inDanger = false;
        if (dir !== 'STAY') {
            var d2 = DIRS[dir];
            var nr2 = gs.player.row + d2.dr, nc2 = gs.player.col + d2.dc;
            if (dangerSet[nr2 + ',' + nc2]) inDanger = true;
        }
        // Also flag STAY as dangerous if current tile is in danger set
        if (dir === 'STAY' && dangerSet[gs.player.row + ',' + gs.player.col]) inDanger = true;
        // Penalize moves into danger zones — MC simulation may not catch all random outcomes
        if (inDanger && survived === SAMPLES) avgTC += 6;

        // 2-hop safety: when Coily is close, verify the move has a safe follow-up
        if (survived === SAMPLES && coilyR >= 0 && dir !== 'STAY') {
            var curCoilyDist = Math.abs(coilyR - gs.player.row) + Math.abs(coilyC - gs.player.col);
            if (curCoilyDist <= 4) {
                // Check if the resulting position has at least one safe 2nd move
                var has2ndSafe = false;
                var hop2Samples = 4;
                for (var d2k = 0; d2k < DIR_KEYS_WITH_STAY.length; d2k++) {
                    var d2dir = DIR_KEYS_WITH_STAY[d2k];
                    var d2surv = 0;
                    for (var d2s = 0; d2s < hop2Samples; d2s++) {
                        simSeed(k * 1000 + d2k * 100 + d2s);
                        var d2c = simDeepClone(gs);
                        if (simStep(d2c, dir) && simStep(d2c, d2dir)) d2surv++;
                    }
                    if (d2surv === hop2Samples) { has2ndSafe = true; break; }
                }
                if (!has2ndSafe) {
                    // This move leads to a trapped position — demote it
                    avgTC += 20;
                    survived = 0; // treat as unsafe
                    aiMoveScores[dir] = -5000;
                }
            }
        }

        if (survived === SAMPLES) {
            // 100% survival — safe move
            if (!inDanger) {
                if (avgTC < bestSafeCost) { bestSafeCost = avgTC; bestSafeDir = dir; }
            } else {
                if (avgTC < bestUnsafeCost) { bestUnsafeCost = avgTC; bestUnsafeDir = dir; }
            }
        }
        // Track best overall (for fallback)
        if (survRate > bestAnySurv || (survRate === bestAnySurv && avgTC < bestAnyCost)) {
            bestAnySurv = survRate; bestAnyCost = avgTC; bestAnyDir = dir;
        }
    }

    // Slick pursuit: catch nearby slicks if the move is safe (lv3+)
    if (gs.lv >= 3) {
        var bestSlickDir = null, bestSlickDist = Infinity;
        for (var si = 0; si < gs.enemies.length; si++) {
            var se = gs.enemies[si];
            if (se.type !== 'slick') continue;
            var spos = enemyEffectivePos(se);
            // Predict where slick will be next hop (DL or DR, random — check both)
            var slickNexts = [spos];
            if (isValidPos(spos.row + 1, spos.col)) slickNexts.push({ row: spos.row + 1, col: spos.col });
            if (isValidPos(spos.row + 1, spos.col + 1)) slickNexts.push({ row: spos.row + 1, col: spos.col + 1 });
            for (var sk = 0; sk < DIR_KEYS.length; sk++) {
                var sdk = DIRS[DIR_KEYS[sk]];
                var snr = gs.player.row + sdk.dr, snc = gs.player.col + sdk.dc;
                if (!isValidPos(snr, snc)) continue;
                for (var sni = 0; sni < slickNexts.length; sni++) {
                    var sd = Math.abs(snr - slickNexts[sni].row) + Math.abs(snc - slickNexts[sni].col);
                    if (sd < bestSlickDist) {
                        var slickScore = aiMoveScores[DIR_KEYS[sk]];
                        if (slickScore !== undefined && slickScore >= 0 && simCanMove(gs, DIR_KEYS[sk])) {
                            bestSlickDist = sd; bestSlickDir = DIR_KEYS[sk];
                        }
                    }
                }
            }
        }
        // Only intercept if we're very close (distance 0 = same tile, 1 = adjacent)
        if (bestSlickDir && bestSlickDist <= 0) {
            restoreRng(); return bestSlickDir;
        }
    }

    // Tour planner direction — use it if it's safe AND not in danger set
    var tourDir = dynamicTourMove(gs);
    if (tourDir !== null) {
        var tourScore = aiMoveScores[tourDir];
        if (tourScore !== undefined && tourScore >= 0) {
            var td2 = DIRS[tourDir];
            var tnr2 = gs.player.row + td2.dr, tnc2 = gs.player.col + td2.dc;
            if (!dangerSet[tnr2 + ',' + tnc2]) {
                restoreRng(); return tourDir;
            }
            // Tour direction is in danger set — fall through to prefer bestSafeDir
        }
    }

    // Fall back: best safe direction, then best unsafe, then best overall
    restoreRng();
    if (bestSafeDir) return bestSafeDir;
    if (bestUnsafeDir) return bestUnsafeDir;
    if (bestAnyDir) return bestAnyDir;
    return 'STAY';
}

// ─── Main entry point ────────────────────────────────────────────────────────
var aiMoveScores = {};  // exported per-direction scores for viz
var aiMode = 0;         // 0 = no AI, 1 = unified (always set to 1 now)
var aiStayCount = 0;    // consecutive STAY decisions — used to break stuck loops
var aiLastPos = '';     // last position key — used to detect oscillation
var aiSamePosCount = 0; // frames spent on same tile
var aiLastRemaining = 99; // cubes remaining last time we checked
var aiNoProgressCount = 0; // moves without reducing remaining cubes
var aiPosHistory = [];  // recent position history for oscillation detection
var AI_HISTORY_LEN = 8; // how many positions to track

function aiPickBestDir() {
    var coilyActive = false;
    for (var i = 0; i < enemies.length; i++) {
        if (enemies[i].type === 'coily') coilyActive = true;
        if (enemies[i].type === 'egg' && (enemies[i].willHatch || (enemies[i].hops || 0) >= 5)) coilyActive = true;
    }

    var gs = simCloneGameState();
    aiMoveScores = {};
    aiMode = 1;

    // Track how long we've been on the same tile
    var posKey = gs.player.row + ',' + gs.player.col;
    if (posKey === aiLastPos) aiSamePosCount++;
    else { aiSamePosCount = 0; aiLastPos = posKey; }

    // Track progress: count remaining cubes
    var tgt = gs.tgt;
    var curRemaining = 0;
    for (var ci = 0; ci < gs.cubes.length; ci++)
        if (gs.cubes[ci].state < tgt) curRemaining++;
    if (curRemaining < aiLastRemaining) {
        aiLastRemaining = curRemaining;
        aiNoProgressCount = 0;
    } else {
        aiNoProgressCount++;
    }

    var result = unifiedPick(gs, coilyActive);

    // Track position history for oscillation detection
    aiPosHistory.push(posKey);
    if (aiPosHistory.length > AI_HISTORY_LEN) aiPosHistory.shift();

    // Detect oscillation: A-B-A or A-B-C-A-B-C patterns
    // Skip override if result leads to an unfinished cube (tour planner's target)
    var destIsUnfinished = false;
    if (result !== 'STAY' && gs.lv >= 3) {
        var dd = DIRS[result];
        var ddr = gs.player.row + dd.dr, ddc = gs.player.col + dd.dc;
        for (var dci = 0; dci < gs.cubes.length; dci++) {
            if (gs.cubes[dci].row === ddr && gs.cubes[dci].col === ddc && gs.cubes[dci].state < gs.tgt) {
                destIsUnfinished = true; break;
            }
        }
    }
    if (result !== 'STAY' && !destIsUnfinished && aiPosHistory.length >= 3) {
        var h = aiPosHistory;
        var len = h.length;
        var oscillating = false;
        if (len >= 3 && h[len-1] === h[len-3] && h[len-1] !== h[len-2]) oscillating = true;
        if (len >= 6 && h[len-1] === h[len-4] && h[len-2] === h[len-5] && h[len-3] === h[len-6]) oscillating = true;

        if (oscillating) {
            var d = DIRS[result];
            var destKey = (gs.player.row + d.dr) + ',' + (gs.player.col + d.dc);
            var recentTiles = {};
            for (var ri = Math.max(0, len - 4); ri < len; ri++) recentTiles[h[ri]] = true;
            if (recentTiles[destKey]) {
                // Build completed cube set for revert avoidance
                var completedCubes = {};
                if (gs.lv >= 3) {
                    for (var cci = 0; cci < gs.cubes.length; cci++)
                        if (gs.cubes[cci].state >= gs.tgt) completedCubes[gs.cubes[cci].row + ',' + gs.cubes[cci].col] = true;
                }
                var altDir = null, altScore = -Infinity;
                for (var ak = 0; ak < DIR_KEYS.length; ak++) {
                    if (DIR_KEYS[ak] === result) continue;
                    if (!simCanMove(gs, DIR_KEYS[ak])) continue;
                    var ad = DIRS[DIR_KEYS[ak]];
                    var aKey = (gs.player.row + ad.dr) + ',' + (gs.player.col + ad.dc);
                    if (recentTiles[aKey]) continue;
                    var asc = aiMoveScores[DIR_KEYS[ak]];
                    // Only accept moves with 100% survival (score >= 0)
                    if (asc !== undefined && asc < 0) continue;
                    // At level 3+: avoid alternatives that revert completed cubes
                    if (completedCubes[aKey]) continue;
                    if (asc !== undefined && asc > altScore) { altScore = asc; altDir = DIR_KEYS[ak]; }
                    else if (asc === undefined) {
                        var vc = simDeepClone(gs);
                        if (simStep(vc, DIR_KEYS[ak]) && !altDir) altDir = DIR_KEYS[ak];
                    }
                }
                // If no non-reverting alternative, allow reverting ones (but still not recent)
                if (!altDir) {
                    for (var ak2 = 0; ak2 < DIR_KEYS.length; ak2++) {
                        if (DIR_KEYS[ak2] === result) continue;
                        if (!simCanMove(gs, DIR_KEYS[ak2])) continue;
                        var ad2 = DIRS[DIR_KEYS[ak2]];
                        var aKey2 = (gs.player.row + ad2.dr) + ',' + (gs.player.col + ad2.dc);
                        if (recentTiles[aKey2]) continue;
                        var asc2 = aiMoveScores[DIR_KEYS[ak2]];
                        if (asc2 !== undefined && asc2 < 0) continue;
                        if (asc2 !== undefined && asc2 > altScore) { altScore = asc2; altDir = DIR_KEYS[ak2]; }
                    }
                }
                if (altDir) { result = altDir; aiPosHistory.length = 0; }
            }
        }
    }

    // Break stuck STAY loops
    if (result === 'STAY') {
        aiStayCount++;
        if (aiStayCount >= 3) {
            var bestAlt = null, bestAltScore = -Infinity;
            for (var k = 0; k < DIR_KEYS.length; k++) {
                if (simCanMove(gs, DIR_KEYS[k])) {
                    var sc = aiMoveScores[DIR_KEYS[k]];
                    if (sc !== undefined && sc < 0) continue;
                    if (sc !== undefined && sc > bestAltScore) {
                        bestAltScore = sc; bestAlt = DIR_KEYS[k];
                    } else if (sc === undefined) {
                        var vc2 = simDeepClone(gs);
                        if (simStep(vc2, DIR_KEYS[k]) && !bestAlt) bestAlt = DIR_KEYS[k];
                    }
                }
            }
            if (bestAlt) { result = bestAlt; aiStayCount = 0; }
        }
    } else {
        aiStayCount = 0;
    }

    return result;
}
