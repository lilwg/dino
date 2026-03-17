// qbert-ai.js — Q*bert AI logic  (v6 — cascade-aware routing)
var AI_VERSION = 'v6-cascade-routing';
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


// Dijkstra from srcIdx with penalty for stepping on completed cubes.
// discSources: optional array of idx that have a 1-hop disc edge to apex (idx 0).
// Returns {dist, prev, usedDisc} — usedDisc[v] is the disc source idx if shortest
// path to v used a disc, else -1.
function dijkstraFrom(srcIdx, stomps, penalty, discSources) {
    var dist = new Float64Array(POS_COUNT);
    var prev = new Int8Array(POS_COUNT);
    var visited = new Uint8Array(POS_COUNT);
    var usedDisc = new Int8Array(POS_COUNT);
    for (var i = 0; i < POS_COUNT; i++) { dist[i] = 999; prev[i] = -1; usedDisc[i] = -1; }
    dist[srcIdx] = 0; prev[srcIdx] = srcIdx;
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
            var cost = 1 + (stomps[v] === 0 ? penalty : 0);
            var nd = dist[u] + cost;
            if (nd < dist[v]) { dist[v] = nd; prev[v] = u; usedDisc[v] = usedDisc[u]; }
        }
        // Disc edge: from disc-adjacent cube to apex (idx 0) in 1 hop
        if (discSources) {
            for (var d = 0; d < discSources.length; d++) {
                if (discSources[d] >= 0 && u === discSources[d] && !visited[0]) {
                    var cost = 1 + (stomps[0] === 0 ? penalty : 0);
                    var nd = dist[u] + cost;
                    if (nd < dist[0]) {
                        dist[0] = nd; prev[0] = u;
                        usedDisc[0] = d; // track which disc index was used
                    }
                }
            }
        }
    }
    return {dist: dist, prev: prev, usedDisc: usedDisc};
}

// Greedy nearest-neighbor tour cost via Dijkstra.
// On toggle levels (lv3+), penalizes routing through completed cubes and
// models cascade reverts. On non-toggle levels, degenerates to BFS.
function greedyTourCost(startIdx, cubes, tgt, lv, discs) {
    var stomps = new Int8Array(POS_COUNT);
    for (var i = 0; i < cubes.length; i++) {
        var idx = posToIdx[cubes[i].row * ROWS + cubes[i].col];
        stomps[idx] = stompsNeeded(cubes[i].state, lv);
    }

    var discSources = [];
    if (discs) {
        for (var di = 0; di < discs.length; di++) {
            var disc = discs[di];
            if (!disc.active) continue;
            var dCol = disc.side === 0 ? 0 : disc.row;
            discSources.push(posToIdx[disc.row * ROWS + dCol]);
        }
    }

    var isToggle = lv >= 3;
    var REVERT_PENALTY = isToggle ? 4 : 0;
    var curIdx = startIdx;
    var totalHops = 0;

    for (var iter = 0; iter < 200; iter++) {
        var dijk = dijkstraFrom(curIdx, stomps, REVERT_PENALTY, discSources);

        var bestIdx = -1, bestDist = 999;
        for (var i = 0; i < POS_COUNT; i++) {
            if (stomps[i] > 0 && i !== curIdx) {
                var d = dijk.dist[i];
                if (d < bestDist || (d === bestDist && (bestIdx === -1 || i < bestIdx))) {
                    bestDist = d; bestIdx = i;
                }
            }
        }
        if (bestIdx === -1) {
            if (stomps[curIdx] > 0) totalHops += stomps[curIdx] * 2;
            break;
        }

        // Consume disc if path used one
        var discIdx = dijk.usedDisc[bestIdx];
        if (discIdx >= 0 && discIdx < discSources.length) {
            discSources[discIdx] = -1;
        }

        // Walk the Dijkstra path, count real hops
        var path = [], pc = bestIdx;
        while (pc !== curIdx) { path.push(pc); pc = dijk.prev[pc]; }
        totalHops += path.length;

        // Apply stomps; on toggle levels, reverted cubes become new targets
        for (var p = path.length - 1; p >= 0; p--) {
            var pos = path[p];
            if (stomps[pos] > 0) {
                stomps[pos]--;
            } else if (isToggle) {
                stomps[pos] = lv >= 5 ? 2 : 1;
            }
        }
        curIdx = bestIdx;
    }

    return totalHops;
}

// Tour cost from a simulation state
function simTourCost(gs) {
    return greedyTourCost(posToIdx[gs.player.row * ROWS + gs.player.col], gs.cubes, gs.tgt, gs.lv, gs.discs);
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

        // Check spawn-timers that will expire during this hop — enemy spawns mid-jump
        if (e.type === 'spawn-timer') {
            if (e.timer <= maxFrames) {
                var ft = e.forcedType;
                if (!ft) {
                    var hasCoilyOrEgg = false;
                    for (var ci = 0; ci < gs.enemies.length; ci++)
                        if (gs.enemies[ci].type === 'coily' || gs.enemies[ci].type === 'egg') { hasCoilyOrEgg = true; break; }
                    ft = hasCoilyOrEgg ? 'redball' : 'egg';
                }
                // Redballs and eggs spawn at row 1, col 0 or 1 — check both
                if (ft === 'redball' || ft === 'egg') {
                    for (var sc = 0; sc < 2; sc++) {
                        for (var f = e.timer; f < maxFrames; f++) {
                            var pt = playerTiles[f];
                            if (pt && pt.row === 1 && pt.col === sc) return false;
                        }
                    }
                }
            }
            continue;
        }

        // Skip non-threatening types and Coily (deterministic — MC handles perfectly)
        if (e.type === 'slick' || e.type === 'greenball') continue;
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

function aiTourInit() {
    aiLastRemaining = 99; aiNoProgressCount = 0; aiStayCount = 0; aiSamePosCount = 0; aiPosHistory = [];
}

// Dijkstra tour planner — nearest unfinished cube via weighted BFS
// On toggle levels (lv3+), uses cluster-based sweep planning:
// finds connected components of unfinished cubes and targets the nearest
// cluster's closest member, preferring paths that don't cross completed cubes.


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

        // Never enter a completed dead-end cube (e.g. bottom corners) — no reason to visit
        if (dir !== 'STAY') {
            var dde = DIRS[dir];
            var lr = gs.player.row + dde.dr, lc = gs.player.col + dde.dc;
            if (isValidPos(lr, lc)) {
                var lidx = posToIdx[lr * ROWS + lc];
                if (lidx >= 0 && posAdj[lidx].length <= 1) {
                    var cubeComplete = false;
                    for (var ci = 0; ci < gs.cubes.length; ci++) {
                        if (gs.cubes[ci].row === lr && gs.cubes[ci].col === lc && gs.cubes[ci].state >= gs.tgt) {
                            cubeComplete = true; break;
                        }
                    }
                    if (cubeComplete) continue;
                }
            }
        }

        // Hop 1: simulate this direction
        var survived = 0, totalTC = 0;
        var hop1States = [];  // save states for hop 2+ check
        for (var s = 0; s < SAMPLES; s++) {
            simSeed(k * 100 + s);
            var child = simDeepClone(gs);
            var alive = simStep(child, dir);
            if (alive) {
                survived++;
                if (child.levelWon) totalTC -= 1000;
                else totalTC += simTourCost(child);
                if (hop1States.length < 10) hop1States.push(child);
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
        if (safe1[dir] && hasEnemies) {
            restoreRng();
            if (dir === 'STAY') {
                // Short-window exhaustive for STAY: only check 1 enemy hop cycle
                // (full window causes false positives from distant enemies).
                var stayFrames = 10;
                var stayTiles = [];
                for (var sf = 0; sf < stayFrames; sf++) stayTiles.push({ row: gs.player.row, col: gs.player.col });
                var stayUnsafe = false;
                for (var sei = 0; sei < gs.enemies.length; sei++) {
                    var se = gs.enemies[sei];
                    if (se.type === 'spawn-timer' || se.type === 'slick' || se.type === 'greenball' || se.type === 'coily') continue;
                    var ser = se.jumping && se.jumpT >= 0.67 ? (se.destRow != null ? se.destRow : se.row) : se.row;
                    var sec = se.jumping && se.jumpT >= 0.67 ? (se.destCol != null ? se.destCol : se.col) : se.col;
                    if (Math.abs(ser - gs.player.row) + Math.abs(sec - gs.player.col) > 2) continue;
                    var seClone = cloneEnemyLight(se);
                    if (enemyPathCollides(seClone, stayTiles, 0, stayFrames, gs.player.row, gs.player.col, gs.sm)) {
                        stayUnsafe = true; break;
                    }
                }
                if (stayUnsafe) { safe1[dir] = false; hop1Surv[dir] = 0; }
            } else if (!isExhaustiveSafe(gs, dir)) {
                safe1[dir] = false;
                hop1Surv[dir] = 0;
            }
        }

        // Export for viz
        if (!safe1[dir] && survived === SAMPLES) aiMoveScores[dir] = -8000; // exhaustive check blocked
        else if (survived === 0) aiMoveScores[dir] = -10000;
        else if (survived === SAMPLES && safe1[dir]) aiMoveScores[dir] = 10000 - (totalTC / survived);
        else aiMoveScores[dir] = (survived / SAMPLES) * 100 - 100;

        // Hop 2+3: if hop 1 is safe and enemies exist, verify a safe 3-hop chain.
        // Hop 2: MC (3 seeds) + exhaustive. Hop 3: MC only (avoids cornering).
        if (safe1[dir] && hasEnemies && dir !== 'STAY') {
            var has2ndSafe = false;
            for (var d2k = 0; d2k < DIR_KEYS_WITH_STAY.length; d2k++) {
                var d2dir = DIR_KEYS_WITH_STAY[d2k];
                var d2ok = true;
                var hop2States = [];
                // MC check: multiple seeds per hop1State for reliability
                for (var si = 0; si < hop1States.length; si++) {
                    var stateOk = true;
                    for (var s2 = 0; s2 < 3; s2++) {
                        simSeed(k * 1000 + d2k * 100 + si * 10 + s2);
                        var d2c = simDeepClone(hop1States[si]);
                        if (!simStep(d2c, d2dir)) { stateOk = false; break; }
                        else if (s2 === 0 && hop2States.length < 6) hop2States.push(d2c);
                    }
                    if (!stateOk) { d2ok = false; break; }
                }
                // Exhaustive check on hop-2: catch rare enemy paths MC misses
                if (d2ok && d2dir !== 'STAY') {
                    for (var si2 = 0; si2 < hop1States.length; si2++) {
                        if (!isExhaustiveSafe(hop1States[si2], d2dir)) { d2ok = false; break; }
                    }
                }
                // Hop 3: verify at least one safe escape from hop-2 state (anti-cornering)
                if (d2ok && hop2States.length > 0) {
                    var has3rdSafe = false;
                    for (var d3k = 0; d3k < DIR_KEYS_WITH_STAY.length; d3k++) {
                        var d3dir = DIR_KEYS_WITH_STAY[d3k];
                        var d3ok = true;
                        for (var si3 = 0; si3 < hop2States.length; si3++) {
                            simSeed(k * 10000 + d2k * 1000 + d3k * 100 + si3);
                            var d3c = simDeepClone(hop2States[si3]);
                            if (!simStep(d3c, d3dir)) { d3ok = false; break; }
                        }
                        if (d3ok) { has3rdSafe = true; break; }
                    }
                    if (!has3rdSafe) d2ok = false;
                }
                if (d2ok && hop1States.length > 0) { has2ndSafe = true; break; }
            }
            safe2[dir] = has2ndSafe;
            if (!has2ndSafe) {
                aiMoveScores[dir] = -5000;
            }
        } else if (dir === 'STAY' && hasEnemies) {
            // STAY is safe2 only if at least one movement direction passed safe1.
            // Prevents sitting in danger zones while Coily closes in.
            var canEscape = false;
            for (var ek = 0; ek < DIR_KEYS.length; ek++) {
                if (safe1[DIR_KEYS[ek]]) { canEscape = true; break; }
            }
            safe2[dir] = canEscape;
        } else {
            safe2[dir] = true;  // no enemies — skip hop 2+3 check
        }
    }

    aiLastHop1Surv = hop1Surv;
    aiLastTourCosts = tourCosts;

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

    // Pick safe direction with lowest tour cost
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
var aiLastTourCosts = {};  // last per-direction tour costs from unifiedPick
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

    // Track position history
    aiPosHistory.push(posKey);
    if (aiPosHistory.length > AI_HISTORY_LEN) aiPosHistory.shift();

    // Stuck breaker: if no progress and looping in few unique positions,
    // pick a safe unvisited direction toward an unfinished cube
    if (aiNoProgressCount > 12 && result !== 'STAY') {
        var dd = DIRS[result];
        var dr = gs.player.row + dd.dr, dc = gs.player.col + dd.dc;
        var destUnfinished = false;
        for (var i = 0; i < gs.cubes.length; i++) {
            if (gs.cubes[i].row === dr && gs.cubes[i].col === dc && gs.cubes[i].state < gs.tgt) {
                destUnfinished = true; break;
            }
        }
        if (!destUnfinished && aiPosHistory.length >= 6) {
            var recent = {};
            for (var ri = 0; ri < aiPosHistory.length; ri++) recent[aiPosHistory[ri]] = true;
            var uniqueCount = 0;
            for (var rk in recent) uniqueCount++;
            if (uniqueCount <= 4) {
                var bestAlt = null, bestAltScore = -Infinity;
                for (var ak = 0; ak < DIR_KEYS.length; ak++) {
                    if (!simCanMove(gs, DIR_KEYS[ak])) continue;
                    var ad = DIRS[DIR_KEYS[ak]];
                    var aKey = (gs.player.row + ad.dr) + ',' + (gs.player.col + ad.dc);
                    if (recent[aKey]) continue;
                    var asc = aiMoveScores[DIR_KEYS[ak]];
                    if (asc === undefined || asc < 0) continue;
                    if (asc > bestAltScore) { bestAltScore = asc; bestAlt = DIR_KEYS[ak]; }
                }
                if (bestAlt) { result = bestAlt; aiNoProgressCount = 0; aiPosHistory.length = 0; }
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
