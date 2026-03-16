// qbert-ai.js — Q*bert AI logic  (v2 — oscillation fix + revert penalty)
var AI_VERSION = 'v5-routing-safety';
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
    if (lv === 3) basePenalty = 8;       // toggle: stepping on completed cube undoes work (need 2 extra hops)
    else if (lv === 4) basePenalty = 6;  // 2-step cycle: revert + re-stomp
    else basePenalty = 7;                // 3-step cycle: revert to 0 + 2 re-stomps

    // Scale penalty down when few cubes remain — crossing completed cubes
    // is worth it to reach the last few unfinished ones instead of long detours
    if (cubes) {
        var remaining = 0;
        for (var i = 0; i < cubes.length; i++)
            if (cubes[i].state < (tgt || 1)) remaining++;
        // Scale down only when very few remain
        if (remaining <= 3) basePenalty = Math.max(2, Math.round(basePenalty * remaining / 4));
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

// Build danger set — marks tiles where non-Coily enemies are or will move
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
            // Egg about to hatch into Coily — mark all adjacent tiles dangerous
            if (e.type === 'egg' && ((e.hops || 0) >= 4 || e.willHatch)) {
                for (var ek = 0; ek < DIR_KEYS.length; ek++) {
                    var edk = DIRS[DIR_KEYS[ek]];
                    var enr = er + edk.dr, enc = ec + edk.dc;
                    if (isValidPos(enr, enc)) danger[enr + ',' + enc] = true;
                }
            }
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

// ─── Exhaustive nearby-enemy safety check ───────────────────────────────────
// For enemies within a few tiles of the player's destination, enumerate ALL
// possible movement paths instead of relying on MC sampling.  This catches
// collisions that 20 random seeds can miss (e.g. ugg/wrongway approaching
// from the side with a 12% collision probability → 8% MC miss rate).
//
// Approach: for each nearby non-deterministic enemy, recursively try both
// direction choices at every hop and check frame-level collision with the
// player.  With at most 2 hops per enemy per player jump, this is 2^2 = 4
// paths per enemy — trivially fast.

var EXHAUSTIVE_RADIUS = 5; // Manhattan-distance threshold for "nearby"

// Precompute the player's collision tile at each frame during a jump.
// Returns an array where index = frame number, value = {row,col} or null (immune).
// Returns null for disc moves (player goes off-grid).
function computePlayerTiles(pRow, pCol, dir, sm) {
    if (dir === 'STAY') {
        var maxWait = Math.ceil(1.0 / (PLAYER_JUMP_DUR * sm)) + 10;
        var tiles = [];
        for (var f = 0; f < maxWait; f++) tiles.push({ row: pRow, col: pCol });
        return tiles;
    }
    var d = DIRS[dir];
    var destR = pRow + d.dr, destC = pCol + d.dc;
    if (!isValidPos(destR, destC)) return null; // disc move — skip
    var jumpDur = PLAYER_JUMP_DUR * sm;
    var tiles = [];
    var jumpT = 0;
    var landed = false;
    for (var f = 0; f < 60; f++) {
        if (!landed) {
            jumpT += jumpDur;
            if (jumpT >= 1) {
                landed = true;
                tiles.push({ row: destR, col: destC });
                continue;
            }
            if (jumpT < 0.33) tiles.push({ row: pRow, col: pCol });
            else if (jumpT >= 0.67) tiles.push({ row: destR, col: destC });
            else tiles.push(null);
        } else {
            // One idle frame after landing (matches simStep post-landing check)
            tiles.push({ row: destR, col: destC });
            break;
        }
    }
    return tiles;
}

// Lightweight clone of a single enemy for the exhaustive search tree
function cloneEnemyLight(e) {
    return {
        type: e.type, row: e.row, col: e.col,
        jumping: e.jumping, jumpT: e.jumpT, jumpDur: e.jumpDur,
        destRow: e.destRow, destCol: e.destCol,
        moveTimer: e.moveTimer, moveInterval: e.moveInterval,
        hops: e.hops || 0, falling: e.falling || false,
        willHatch: e.willHatch || false
    };
}

// All possible move destinations for an enemy at a hop decision point.
// Coily is deterministic (chases player), so returns exactly 1 choice.
// Random enemies (ugg, wrongway, redball, egg) return 2 choices.
function getEnemyMoveChoices(e, playerDestR, playerDestC) {
    if (e.type === 'coily') {
        var bestDist = Infinity, bestR = e.row, bestC = e.col;
        for (var k = 0; k < 4; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var tr = e.row + dk.dr, tc = e.col + dk.dc;
            if (!isValidPos(tr, tc)) continue;
            var dist = Math.abs(playerDestR - tr) + Math.abs(playerDestC - tc);
            if (dist < bestDist) { bestDist = dist; bestR = tr; bestC = tc; }
        }
        return [{ nr: bestR, nc: bestC }];
    }
    if (e.type === 'egg' || e.type === 'redball') {
        return [{ nr: e.row + 1, nc: e.col }, { nr: e.row + 1, nc: e.col + 1 }];
    }
    if (e.type === 'ugg') {
        return [{ nr: e.row - 1, nc: e.col - 1 }, { nr: e.row, nc: e.col - 1 }];
    }
    if (e.type === 'wrongway') {
        return [{ nr: e.row - 1, nc: e.col }, { nr: e.row, nc: e.col + 1 }];
    }
    return [];
}

// Get the collision tile for an enemy (mirrors collisionTile in qbert.js)
function enemyCollisionTile(e) {
    if (!e.jumping) return { row: e.row, col: e.col };
    if (e.jumpT < 0.33) return { row: e.row, col: e.col };
    if (e.jumpT >= 0.67) return { row: e.destRow, col: e.destCol };
    return null; // immune at apex
}

// Recursive search: can this single enemy collide with the player on ANY
// possible path?  Branches at each move-decision point (2 choices per hop).
// Returns true if any branch produces a collision.
function enemyPathCollides(e, playerTiles, frame, maxFrames, pDestR, pDestC, sm) {
    if (frame >= maxFrames || e.falling) return false;

    // ── Advance enemy by one frame ──
    if (e.jumping) {
        e.jumpT += e.jumpDur;
        if (e.jumpT >= 1) {
            e.jumping = false;
            e.row = e.destRow; e.col = e.destCol;
            if (!isValidPos(e.row, e.col)) return false; // fell off
            if (e.type === 'egg' && ((e.hops || 0) >= 6 || e.row >= ROWS - 1)) {
                e.type = 'coily';
                e.moveInterval = enemyMoveInterval('coily', sm);
            }
        }
        // Collision check
        var et = enemyCollisionTile(e);
        var pt = playerTiles[frame];
        if (et && pt && et.row === pt.row && et.col === pt.col) return true;
        return enemyPathCollides(e, playerTiles, frame + 1, maxFrames, pDestR, pDestC, sm);
    }

    // ── Idle: tick move timer ──
    e.moveTimer++;
    if (e.moveTimer < e.moveInterval) {
        // Not moving yet — check collision at current position
        var pt2 = playerTiles[frame];
        if (pt2 && pt2.row === e.row && pt2.col === e.col) return true;
        return enemyPathCollides(e, playerTiles, frame + 1, maxFrames, pDestR, pDestC, sm);
    }

    // ── Move decision — BRANCH POINT ──
    e.moveTimer = 0;
    var choices = getEnemyMoveChoices(e, pDestR, pDestC);
    for (var ci = 0; ci < choices.length; ci++) {
        var ec = cloneEnemyLight(e);
        ec.jumping = true;
        ec.jumpT = 0;
        ec.destRow = choices[ci].nr;
        ec.destCol = choices[ci].nc;
        ec.hops++;
        if (!isValidPos(choices[ci].nr, choices[ci].nc)) ec.falling = true;
        // Check collision right after starting jump (jumpT=0 < 0.33 → source tile)
        var pt3 = playerTiles[frame];
        if (pt3 && pt3.row === ec.row && pt3.col === ec.col) return true;
        if (enemyPathCollides(ec, playerTiles, frame + 1, maxFrames, pDestR, pDestC, sm)) {
            return true;
        }
    }
    return false;
}

// Main entry: returns true if direction is safe from ALL possible nearby-enemy paths.
function isExhaustiveSafe(gs, dir) {
    var playerTiles = computePlayerTiles(gs.player.row, gs.player.col, dir, gs.sm);
    if (!playerTiles) return true; // disc move — no on-grid collision possible

    var d = DIRS[dir];
    var destR = dir === 'STAY' ? gs.player.row : gs.player.row + d.dr;
    var destC = dir === 'STAY' ? gs.player.col : gs.player.col + d.dc;
    var maxFrames = playerTiles.length;
    var startFrame = Math.min(gs.freezeTimer || 0, maxFrames);

    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        // Skip non-threatening types and coily (deterministic — MC handles it perfectly)
        if (e.type === 'spawn-timer' || e.type === 'slick' || e.type === 'greenball') continue;
        if (e.type === 'coily') continue;

        // Effective position for distance check
        var er = e.jumping && e.jumpT >= 0.67 ? (e.destRow != null ? e.destRow : e.row) : e.row;
        var ec2 = e.jumping && e.jumpT >= 0.67 ? (e.destCol != null ? e.destCol : e.col) : e.col;
        var distDest = Math.abs(er - destR) + Math.abs(ec2 - destC);
        var distSrc = Math.abs(er - gs.player.row) + Math.abs(ec2 - gs.player.col);
        if (distDest > EXHAUSTIVE_RADIUS && distSrc > EXHAUSTIVE_RADIUS) continue;

        var eClone = cloneEnemyLight(e);
        if (enemyPathCollides(eClone, playerTiles, startFrame, maxFrames, destR, destC, gs.sm)) {
            return false;
        }
    }
    return true;
}

// ─── Tour greedy planner ─────────────────────────────────────────────────────
var aiTour = [], aiTourIdx = 0, aiBoardSig = '';
var aiDetailPath = [], aiTourDots = [];

function aiTourInit() { aiLastRemaining = 99; aiNoProgressCount = 0; aiStayCount = 0; aiSamePosCount = 0; aiPosHistory = []; }

// Dijkstra tour planner — nearest unfinished cube via weighted BFS
// On toggle levels (lv3+), uses cluster-based sweep planning:
// finds connected components of unfinished cubes and targets the nearest
// cluster's closest member, preferring paths that don't cross completed cubes.
// Count how many valid moves a tile has (connectivity / escape routes)
function tileDegree(row, col) {
    var deg = 0;
    for (var k = 0; k < 4; k++) {
        var dk = DIRS[DIR_KEYS[k]];
        if (isValidPos(row + dk.dr, col + dk.dc)) deg++;
    }
    return deg;
}

// Build enemy proximity cost map: tiles near dangerous enemies get extra cost.
// Returns { "row,col": costPenalty }.
function buildEnemyProximityMap(gs) {
    var map = {};
    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type === 'spawn-timer' || e.type === 'slick' || e.type === 'greenball') continue;
        var pos = enemyEffectivePos(e);
        var er = pos.row, ec = pos.col;
        // Weight: coily is most dangerous, others less
        var weight = e.type === 'coily' ? 4 : 2;
        // Mark the enemy's tile and nearby tiles (Manhattan distance ≤ 2)
        for (var r = Math.max(0, er - 2); r <= Math.min(ROWS - 1, er + 2); r++) {
            for (var c = 0; c <= r; c++) {
                var d = Math.abs(r - er) + Math.abs(c - ec);
                if (d > 2) continue;
                var key = r + ',' + c;
                var pen = d === 0 ? weight * 2 : (d === 1 ? weight : Math.ceil(weight / 2));
                map[key] = (map[key] || 0) + pen;
            }
        }
    }
    return map;
}

function dynamicTourMove(gs) {
    var lv = gs.lv;
    var tgt = gs.tgt;
    var completedSet = {};
    var unfinishedSet = {};
    var unfinished = [];
    for (var i = 0; i < gs.cubes.length; i++) {
        var c = gs.cubes[i];
        if (c.state >= tgt) completedSet[c.row + ',' + c.col] = true;
        else {
            unfinished.push({ row: c.row, col: c.col });
            unfinishedSet[c.row + ',' + c.col] = true;
        }
    }
    if (unfinished.length === 0) return null;

    var penalty = revertPenalty(lv, gs.cubes, tgt);

    // Enemy proximity map — adds traversal cost near dangerous enemies
    var hasCoily = false;
    for (var ei = 0; ei < gs.enemies.length; ei++) {
        if (gs.enemies[ei].type === 'coily') hasCoily = true;
        if (gs.enemies[ei].type === 'egg' && ((gs.enemies[ei].hops || 0) >= 5 || gs.enemies[ei].willHatch)) hasCoily = true;
    }
    var enemyCost = (hasCoily || gs.enemies.length > 2) ? buildEnemyProximityMap(gs) : {};

    // On toggle levels, find connected clusters of unfinished cubes
    // and give bonus to targets in larger clusters (more sweep potential)
    var clusterSize = {};  // key -> cluster size
    if (lv >= 3 && unfinished.length > 1) {
        // BFS to find connected components among unfinished cubes
        var visited = {};
        for (var ci = 0; ci < unfinished.length; ci++) {
            var ck = unfinished[ci].row + ',' + unfinished[ci].col;
            if (visited[ck]) continue;
            // BFS from this unfinished cube
            var cluster = [ck];
            visited[ck] = true;
            var qi2 = 0;
            while (qi2 < cluster.length) {
                var parts = cluster[qi2].split(',');
                var cr = parseInt(parts[0]), cc = parseInt(parts[1]);
                for (var ck2 = 0; ck2 < 4; ck2++) {
                    var cdk = DIRS[DIR_KEYS[ck2]];
                    var cnk = (cr + cdk.dr) + ',' + (cc + cdk.dc);
                    if (!visited[cnk] && unfinishedSet[cnk]) {
                        visited[cnk] = true;
                        cluster.push(cnk);
                    }
                }
                qi2++;
            }
            for (var cj = 0; cj < cluster.length; cj++)
                clusterSize[cluster[cj]] = cluster.length;
        }
    }

    var startKey = gs.player.row + ',' + gs.player.col;
    var dist = {}; dist[startKey] = 0;
    var reverts = {}; reverts[startKey] = 0;
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

        if (curKey !== startKey && unfinishedSet[curKey]) {
            var adjCost = cur.cost;
            var isCorner = (cur.row === ROWS - 1 && (cur.col === 0 || cur.col === ROWS - 1));
            var isBottom = cur.row >= ROWS - 2;
            var isEdge = cur.col === 0 || cur.col === cur.row;
            // Edge/corner bonus: stomp hard-to-reach tiles first.
            // BUT reduce/flip bonus when enemies are active — escape routes matter.
            if (hasCoily) {
                // With enemies: PENALIZE low-connectivity targets
                var deg = tileDegree(cur.row, cur.col);
                if (deg <= 1) adjCost += 3;       // corners: strong penalty
                else if (deg === 2) adjCost += 1;  // edges: mild penalty
                // Interior tiles (deg 3-4) get no adjustment
            } else {
                // No enemies: keep original bonus (stomp edges early)
                if (isCorner) adjCost -= 2;
                else if (isBottom && isEdge) adjCost -= 1.5;
                else if (isBottom || isEdge) adjCost -= 0.5;
            }
            // Big bonus for zero-revert paths — reached without crossing completed cubes
            if (lv >= 3 && (reverts[curKey] || 0) === 0) adjCost -= 4;
            // Cluster bonus: prefer targets in larger connected groups (sweep-friendly)
            if (lv >= 3 && clusterSize[curKey]) {
                adjCost -= Math.min(clusterSize[curKey], 6) * 0.8;
            }
            if (adjCost < bestCost) { bestCost = adjCost; bestTarget = { row: cur.row, col: cur.col }; }
        }
        if (bestTarget && cur.cost > bestCost + 3) break;

        for (var k = 0; k < 4; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = cur.row + dk.dr, nc = cur.col + dk.dc;
            if (!isValidPos(nr, nc)) continue;
            var nk = nr + ',' + nc;
            var isCompleted = !!completedSet[nk];
            var moveCost = 1 + (isCompleted ? penalty : 0);
            // Enemy proximity cost — routes around enemies instead of through them
            if (enemyCost[nk]) moveCost += enemyCost[nk];
            // On toggle levels, penalize completed dead-end tiles
            if (isCompleted && lv >= 3) {
                var isApex = (nr === 0 && nc === 0);
                var isCrnr = (nr === ROWS - 1 && (nc === 0 || nc === ROWS - 1));
                var isEdgeT = (nc === 0 || nc === nr) && !isApex && !isCrnr;
                if (isApex || isCrnr) moveCost += 10;  // strongly avoid
                else if (isEdgeT) moveCost += 5;        // discouraged
            } else if (isCompleted) {
                var isApex2 = (nr === 0 && nc === 0);
                var isCrnr2 = (nr === ROWS - 1 && (nc === 0 || nc === ROWS - 1));
                if (isApex2 || isCrnr2) moveCost += 4;
            }
            var newCost = cur.cost + moveCost;
            if (dist[nk] === undefined || newCost < dist[nk]) {
                dist[nk] = newCost;
                reverts[nk] = (reverts[curKey] || 0) + (isCompleted ? 1 : 0);
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

// ─── Scoring helpers (removed — safety is now handled by 2-hop MC simulation) ─

// ─── Route-first AI: plan optimal path, validate safety via 2-hop simulation ─
// Philosophy: tour planner decides WHERE to go (optimal routing), simulation
// validates IF it's safe (next 2 hops collision-free). If not safe, STAY.
// No heuristic scoring — just routing + timing.

function unifiedPick(gs, coilyActive) {
    var savedRng = simRng;
    var baseSeed = (gs.player.row * 7 + gs.player.col) * 10000 + (frameCount || 0);
    function simSeed(sampleIdx) { simRng = createSeededRng(baseSeed + sampleIdx * 9973); }
    function restoreRng() { simRng = savedRng; }

    var tourDir = dynamicTourMove(gs);
    aiLastTourDir = tourDir;

    // MC samples for safety validation — enough to catch random enemy moves
    var hasEnemies = gs.enemies.length > 0;
    var SAMPLES = coilyActive ? 20 : (hasEnemies ? 12 : 4);

    // Disc lure — use when Coily is active
    if (coilyActive) {
        var lureDir = evalDiscLure();
        if (lureDir) {
            var lureSafe = 0;
            for (var ls = 0; ls < SAMPLES; ls++) {
                simSeed(ls);
                var lc = simDeepClone(gs);
                if (simStep(lc, lureDir)) lureSafe++;
            }
            if (lureSafe === SAMPLES && isExhaustiveSafe(gs, lureDir)) { restoreRng(); return lureDir; }
        }
    }

    // ── Core: check each direction for 2-hop safety ──
    // A direction is "safe" if hop 1 survives AND at least one follow-up hop 2 survives.

    var safe1 = {};      // dir -> true if 100% survival on hop 1
    var safe2 = {};      // dir -> true if at least one hop 2 option also survives
    var tourCosts = {};  // dir -> avg tour cost after hop 1
    var hop1Surv = {};   // dir -> survival rate (for fallback)

    for (var k = 0; k < DIR_KEYS_WITH_STAY.length; k++) {
        var dir = DIR_KEYS_WITH_STAY[k];
        if (!simCanMove(gs, dir)) continue;

        // Don't waste discs when there's no Coily
        if (!coilyActive && dir !== 'STAY') {
            var dd = DIRS[dir];
            var dnr = gs.player.row + dd.dr, dnc = gs.player.col + dd.dc;
            if (!isValidPos(dnr, dnc)) continue;
        }

        // Hop 1: simulate this direction
        var survived = 0, totalTC = 0;
        var hop1States = [];  // save states for hop 2 check
        for (var s = 0; s < SAMPLES; s++) {
            simSeed(k * 100 + s);
            var child = simDeepClone(gs);
            var alive = simStep(child, dir);
            if (alive) {
                survived++;
                if (child.levelWon) totalTC -= 1000;
                else totalTC += simTourCost(child);
                if (hop1States.length < 6) hop1States.push(child);
            }
        }

        hop1Surv[dir] = survived / SAMPLES;
        if (survived === SAMPLES) {
            safe1[dir] = true;
            tourCosts[dir] = totalTC / survived;
            if (dir === 'STAY') tourCosts[dir] += 2;  // slight penalty for waiting
        }

        // Exhaustive nearby-enemy check: MC may miss rare collision paths
        // (e.g. ugg/wrongway with 12% hit probability → 8% miss rate at 20 samples).
        // The exhaustive check enumerates ALL possible paths for nearby enemies.
        // Skip for STAY: simStep's STAY exits early (coily hop cycle), exhaustive
        // uses a longer fixed window → false positives.  MC handles STAY correctly.
        if (safe1[dir] && hasEnemies && dir !== 'STAY') {
            restoreRng();
            if (!isExhaustiveSafe(gs, dir)) {
                safe1[dir] = false;
                hop1Surv[dir] = 0;
            }
        }

        // Export for viz
        if (!safe1[dir] && survived === SAMPLES) aiMoveScores[dir] = -8000; // exhaustive check blocked
        else if (survived === 0) aiMoveScores[dir] = -10000;
        else if (survived === SAMPLES && safe1[dir]) aiMoveScores[dir] = 10000 - (totalTC / survived);
        else aiMoveScores[dir] = (survived / SAMPLES) * 100 - 100;

        // Hop 2: if hop 1 is safe and enemies exist, verify at least one safe follow-up
        if (safe1[dir] && hasEnemies && dir !== 'STAY') {
            var has2ndSafe = false;
            for (var d2k = 0; d2k < DIR_KEYS_WITH_STAY.length; d2k++) {
                var d2dir = DIR_KEYS_WITH_STAY[d2k];
                var d2ok = true;
                for (var si = 0; si < hop1States.length; si++) {
                    simSeed(k * 1000 + d2k * 100 + si);
                    var d2c = simDeepClone(hop1States[si]);
                    if (!simStep(d2c, d2dir)) { d2ok = false; break; }
                }
                if (d2ok && hop1States.length > 0) { has2ndSafe = true; break; }
            }
            safe2[dir] = has2ndSafe;
            if (!has2ndSafe) {
                // Hop 1 safe but no safe hop 2 — mark unsafe
                aiMoveScores[dir] = -5000;
            }
        } else {
            safe2[dir] = true;  // no enemies or STAY — skip hop 2 check
        }
    }

    aiLastHop1Surv = hop1Surv;

    // Slick pursuit on toggle levels — catch them if adjacent and safe
    if (gs.lv >= 3) {
        for (var si2 = 0; si2 < gs.enemies.length; si2++) {
            var se = gs.enemies[si2];
            if (se.type !== 'slick') continue;
            var spos = enemyEffectivePos(se);
            for (var sk = 0; sk < DIR_KEYS.length; sk++) {
                var sdk = DIRS[DIR_KEYS[sk]];
                var snr = gs.player.row + sdk.dr, snc = gs.player.col + sdk.dc;
                if (snr === spos.row && snc === spos.col) {
                    if (safe1[DIR_KEYS[sk]] && safe2[DIR_KEYS[sk]]) {
                        restoreRng(); return DIR_KEYS[sk];
                    }
                }
            }
        }
    }

    // Prefer tour planner direction if it's fully safe (hop 1 + hop 2)
    if (tourDir !== null && safe1[tourDir] && safe2[tourDir]) {
        restoreRng(); return tourDir;
    }

    // Fall back: best fully-safe direction by tour cost
    var bestDir = null, bestCost = Infinity;
    for (var fk = 0; fk < DIR_KEYS_WITH_STAY.length; fk++) {
        var fd = DIR_KEYS_WITH_STAY[fk];
        if (!safe1[fd] || !safe2[fd]) continue;
        var fc = tourCosts[fd];
        if (fc !== undefined && fc < bestCost) { bestCost = fc; bestDir = fd; }
    }
    if (bestDir) { restoreRng(); return bestDir; }

    // No fully-safe option — prefer STAY to wait for better timing
    // Only move if STAY itself has poor survival or we'd die anyway
    if (hop1Surv['STAY'] !== undefined && hop1Surv['STAY'] >= 1) {
        restoreRng(); return 'STAY';
    }
    var bestSurv = -1, bestSurvDir = null;
    for (var uk = 0; uk < DIR_KEYS_WITH_STAY.length; uk++) {
        var ud = DIR_KEYS_WITH_STAY[uk];
        if (hop1Surv[ud] !== undefined && hop1Surv[ud] > bestSurv) {
            bestSurv = hop1Surv[ud]; bestSurvDir = ud;
        }
    }
    restoreRng();
    return bestSurvDir || 'STAY';
}

// ─── Main entry point ────────────────────────────────────────────────────────
var aiMoveScores = {};  // exported per-direction scores for viz
var aiLastTourDir = null;  // last tour direction from unifiedPick
var aiLastHop1Surv = {};   // last hop-1 survival rates from unifiedPick
var aiMode = 0;         // 0 = no AI, 1 = unified (always set to 1 now)
var aiStayCount = 0;    // consecutive STAY decisions — used to break stuck loops
var aiLastPos = '';     // last position key — used to detect oscillation
var aiSamePosCount = 0; // frames spent on same tile
var aiLastRemaining = 99; // cubes remaining last time we checked
var aiNoProgressCount = 0; // moves without reducing remaining cubes
var aiPosHistory = [];  // recent position history for oscillation detection
var AI_HISTORY_LEN = 12; // how many positions to track

function aiPickBestDir() {
    // Save game RNG — ALL AI simulation must use seeded RNG, never Math.random
    var savedGameRng = simRng;

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
    } else if (gs.lv >= 3 && curRemaining > aiLastRemaining) {
        // Toggle level: remaining went UP (we reverted cubes) — count faster
        aiNoProgressCount += 2;
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
        // A-B-A pattern (2-cycle)
        if (len >= 3 && h[len-1] === h[len-3] && h[len-1] !== h[len-2]) oscillating = true;
        // A-B-C-A-B-C pattern (3-cycle)
        if (len >= 6 && h[len-1] === h[len-4] && h[len-2] === h[len-5] && h[len-3] === h[len-6]) oscillating = true;
        // A-B-C-D-A-B-C-D pattern (4-cycle)
        if (len >= 8 && h[len-1] === h[len-5] && h[len-2] === h[len-6] && h[len-3] === h[len-7] && h[len-4] === h[len-8]) oscillating = true;
        // General: count unique tiles in recent history — if very few, we're looping
        if (len >= 8) {
            var uniqueTiles = {};
            for (var ui = len - 8; ui < len; ui++) uniqueTiles[h[ui]] = true;
            var uniqueCount = 0;
            for (var uk in uniqueTiles) uniqueCount++;
            if (uniqueCount <= 3) oscillating = true;
        }

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
                        simRng = createSeededRng(ak * 7919);
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

    // No-progress breaker: escalating urgency when stuck without reducing remaining cubes.
    // Phase 1 (>10 moves): try to land on adjacent unfinished cube (safe only)
    // Phase 2 (>20 moves): use tour direction even if not immediately on unfinished cube
    // Phase 3 (>30 moves): accept highest-survival move toward progress (relax 100% safety)
    if (aiNoProgressCount > 10 && result !== 'STAY') {
        var dd3 = DIRS[result];
        var dr3 = gs.player.row + dd3.dr, dc3 = gs.player.col + dd3.dc;
        var destIsUnf3 = false;
        for (var ufi = 0; ufi < gs.cubes.length; ufi++) {
            if (gs.cubes[ufi].row === dr3 && gs.cubes[ufi].col === dc3 && gs.cubes[ufi].state < gs.tgt) {
                destIsUnf3 = true; break;
            }
        }
        if (!destIsUnf3) {
            // Phase 1: find adjacent unfinished cube with safe move
            var bestProgDir = null, bestProgScore = -Infinity;
            for (var pk = 0; pk < DIR_KEYS.length; pk++) {
                if (!simCanMove(gs, DIR_KEYS[pk])) continue;
                var pd = DIRS[DIR_KEYS[pk]];
                var pnr = gs.player.row + pd.dr, pnc = gs.player.col + pd.dc;
                if (!isValidPos(pnr, pnc)) continue;
                for (var pui = 0; pui < gs.cubes.length; pui++) {
                    if (gs.cubes[pui].row === pnr && gs.cubes[pui].col === pnc && gs.cubes[pui].state < gs.tgt) {
                        var psc = aiMoveScores[DIR_KEYS[pk]];
                        if (psc !== undefined && psc >= 0 && psc > bestProgScore) {
                            bestProgScore = psc; bestProgDir = DIR_KEYS[pk];
                        }
                        break;
                    }
                }
            }
            // Phase 2 (>20): use tour direction if safe — it routes around enemies now
            if (!bestProgDir && aiNoProgressCount > 20 && aiLastTourDir !== null) {
                var tsc = aiMoveScores[aiLastTourDir];
                if (tsc !== undefined && tsc >= 0) bestProgDir = aiLastTourDir;
            }
            // Phase 3 (>30): accept highest-survival move (relax 100% requirement)
            if (!bestProgDir && aiNoProgressCount > 30) {
                var bestSurvProg = -1, bestSurvProgDir = null;
                for (var pk3 = 0; pk3 < DIR_KEYS.length; pk3++) {
                    if (!simCanMove(gs, DIR_KEYS[pk3])) continue;
                    var pk3d = DIRS[DIR_KEYS[pk3]];
                    if (!isValidPos(gs.player.row + pk3d.dr, gs.player.col + pk3d.dc)) continue;
                    var pk3surv = aiLastHop1Surv[DIR_KEYS[pk3]];
                    if (pk3surv !== undefined && pk3surv > bestSurvProg) {
                        bestSurvProg = pk3surv; bestSurvProgDir = DIR_KEYS[pk3];
                    }
                }
                if (bestSurvProgDir && bestSurvProg > 0.5) bestProgDir = bestSurvProgDir;
            }
            if (bestProgDir) { result = bestProgDir; aiNoProgressCount = 0; aiPosHistory.length = 0; }
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
                        simRng = createSeededRng(k * 7919 + 5000);
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

    // Restore game RNG — must never leak seeded RNG into real game
    simRng = savedGameRng;
    return result;
}
