// qbert-ai.js — Q*bert AI: hybrid strategy + survival tree
var AI_VERSION = 'v12.0-teacher';
// Requires: qbert.js loaded first (provides constants, board, simulation)
//
// Provides: aiPickBestDir() — main entry point for AI move selection
//
// Architecture: human-style strategy decides WHERE to go, survival tree
// validates IF it's safe. Best of both worlds.
//
// Strategy layer (greedyTourCost):
//   - Bottom-up sweep: complete lower rows first, never backtrack
//   - Corner priority: finish low-exit corner cubes early
//   - Cluster awareness: prefer cubes near other unfinished cubes
//   - Active disc luring: route toward discs when Coily is active
//   - Corner escape: avoid low-exit tiles when Coily is nearby
//
// Safety layer (survive/surviveOne):
//   - Factored survival tree: P(survive) = product of per-enemy trees
//   - Coily simulated deterministically (ROM chase algorithm)
//   - Frame-accurate collision detection during mid-hop flight
//   - 8-hop lookahead with memoized AND-OR tree

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

// Greedy nearest-neighbor tour cost with deterministic tie-breaking.
// On toggle levels, uses Dijkstra to route around completed cubes.
// Ties broken by lowest position index for stability.
function greedyTourCost(startIdx, cubes, tgt, lv, discs, revertCounts) {
    var stomps = new Int8Array(POS_COUNT);
    for (var i = 0; i < cubes.length; i++) {
        var idx = posToIdx[cubes[i].row * ROWS + cubes[i].col];
        stomps[idx] = stompsNeeded(cubes[i].state, lv);
    }

    // Build disc source list: cube positions adjacent to active discs
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
    // L3-4 (toggle): penalty 1.5 (lower = allow more backtracking, detours cost more)
    // L5+ (cycle): penalty 2.5 (higher = reverts cost 3 stomps to fix)
    var REVERT_PENALTY = lv >= 5 ? 2.5 : (isToggle ? 1.5 : 0);
    var curIdx = startIdx;
    var totalHops = 0;

    var _tcIterLimit = (typeof window !== 'undefined' && window.AI_TEACHER) ? 30 : 200;
    for (var iter = 0; iter < _tcIterLimit; iter++) {
        if (isToggle) {
            var dijk = dijkstraFrom(curIdx, stomps, REVERT_PENALTY, discSources);

            var bestIdx = -1, bestDist = 999;
            for (var i = 0; i < POS_COUNT; i++) {
                if (stomps[i] > 0 && i !== curIdx) {
                    var d = dijk.dist[i];
                    // Deprioritize frequently-reverted cubes — go to fresh ones first
                    if (revertCounts && revertCounts[i] > 1) d += (revertCounts[i] - 1) * 3;
                    // Prefer cubes not visited recently — breaks oscillation loops
                    // by steering toward "forgotten" cubes instead of re-visiting familiar ones
                    var curHops = typeof hops !== 'undefined' ? hops : 0;
                    var hopsSinceVisit = curHops - (aiCubeLastVisit[i] || 0);
                    if (hopsSinceVisit < 20) d += (20 - hopsSinceVisit) * 0.5;
                    // Bottom-up sweep: prefer bottom-row cubes to avoid backtracking
                    // through completed upper cubes. Stronger on L3-4 where reverts hurt.
                    var row_i = idxToPos[i][0], col_i = idxToPos[i][1];
                    d -= row_i * (lv >= 5 ? 1.5 : 2);
                    // Corner priority: bottom corners (few exits) should be done first
                    if (row_i >= 4 && (col_i <= 1 || col_i >= row_i - 1)) d -= 2;
                    // Cluster bonus: prefer cubes with unfinished neighbors (sweep clusters together)
                    var adj = posAdj[i];
                    for (var ai = 0; ai < adj.length; ai++) {
                        if (stomps[adj[ai]] > 0) d -= 0.5;
                    }
                    if (d < bestDist || (d === bestDist && (bestIdx === -1 || i < bestIdx))) {
                        bestDist = d; bestIdx = i;
                    }
                }
            }
            if (bestIdx === -1) {
                if (stomps[curIdx] > 0) totalHops += stomps[curIdx] * 2;
                break;
            }

            // Consume the disc if the path to bestIdx used one
            var discIdx = dijk.usedDisc[bestIdx];
            if (discIdx >= 0 && discIdx < discSources.length) {
                discSources[discIdx] = -1; // mark consumed, don't splice (indices are stable)
            }

            // Walk the Dijkstra path, count real hops
            var path = [], pc = bestIdx;
            while (pc !== curIdx) { path.push(pc); pc = dijk.prev[pc]; }
            totalHops += path.length;

            // Apply stomps along path; fix reverts immediately (never leave debt)
            for (var p = path.length - 1; p >= 0; p--) {
                var pos = path[p];
                if (stomps[pos] > 0) {
                    stomps[pos]--;
                } else {
                    totalHops += 2;
                }
            }
            curIdx = bestIdx;
        } else {
            // Non-toggle: use precomputed BFS distances, consider disc shortcuts
            var bestIdx = -1, bestDist = 999;
            var APEX = 0;
            for (var i = 0; i < POS_COUNT; i++) {
                if (stomps[i] > 0 && i !== curIdx) {
                    var d = distMatrix[curIdx * POS_COUNT + i];
                    for (var ds = 0; ds < discSources.length; ds++) {
                        if (discSources[ds] < 0) continue; // consumed
                        var dd = distMatrix[curIdx * POS_COUNT + discSources[ds]] + 1
                               + distMatrix[APEX * POS_COUNT + i];
                        if (dd < d) d = dd;
                    }
                    if (d < bestDist || (d === bestDist && (bestIdx === -1 || i < bestIdx))) {
                        bestDist = d; bestIdx = i;
                    }
                }
            }
            if (bestIdx === -1) {
                if (stomps[curIdx] > 0) totalHops += stomps[curIdx] * 2;
                break;
            }
            // Check if a disc was used for this leg and consume it
            var directDist = distMatrix[curIdx * POS_COUNT + bestIdx];
            var usedDs = -1;
            for (var ds = 0; ds < discSources.length; ds++) {
                if (discSources[ds] < 0) continue; // consumed
                var dd = distMatrix[curIdx * POS_COUNT + discSources[ds]] + 1
                       + distMatrix[APEX * POS_COUNT + bestIdx];
                if (dd < directDist) { directDist = dd; usedDs = ds; }
            }
            if (usedDs >= 0) discSources[usedDs] = -1; // mark consumed
            totalHops += bestDist;
            stomps[bestIdx]--;
            curIdx = bestIdx;
        }
    }

    return totalHops;
}

// Tour cost from a simulation state
function simTourCost(gs) {
    return greedyTourCost(posToIdx[gs.player.row * ROWS + gs.player.col], gs.cubes, gs.tgt, gs.lv, gs.discs, aiRevertCounts);
}

// ─── Danger zone assessment ──────────────────────────────────────────────────

// Simulate Coily chase using actual ROM grid-word algorithm (deterministic)
function coilyChaseStep(cr, cc, targetR, targetC) {
    var c_gw1 = cr - cc + 1;
    var t_gw1 = targetR - targetC + 1;
    var nr, nc;
    if (targetR > cr) {
        if (t_gw1 > c_gw1) { nr = cr + 1; nc = cc; }
        else                { nr = cr + 1; nc = cc + 1; }
    } else {
        if (t_gw1 < c_gw1) { nr = cr - 1; nc = cc; }
        else                { nr = cr - 1; nc = cc - 1; }
    }
    return isValidPos(nr, nc) ? { row: nr, col: nc } : null;
}


function predictCoilyPos(coily, targetRow, targetCol, steps) {
    var cr = coily.row, cc = coily.col;
    for (var s = 0; s < steps; s++) {
        var next = coilyChaseStep(cr, cc, targetRow, targetCol);
        if (!next) break;
        cr = next.row; cc = next.col;
    }
    return { row: cr, col: cc };
}

// Build danger set — marks tiles where non-Coily enemies are or will move
function buildDangerSet() {
    var danger = {};
    var sm = (typeof speedMultiplier === 'function') ? speedMultiplier() : 1;
    var framesPerHop = Math.ceil(1 / (PLAYER_JUMP_DUR * sm));
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'slick' || e.type === 'greenball') continue;
        if (e.type === 'coily') {
            // Mark Coily's current position + predicted next 3 hops
            var cpos = enemyEffectivePos(e);
            danger[cpos.row + ',' + cpos.col] = true;
            var pr = cpos.row, pc = cpos.col;
            for (var cs = 0; cs < 3; cs++) {
                var cp = predictCoilyPos({ row: pr, col: pc }, player.row, player.col, 1);
                if (!isValidPos(cp.row, cp.col)) break;
                danger[cp.row + ',' + cp.col] = true;
                pr = cp.row; pc = cp.col;
            }
            continue;
        }
        if (e.type === 'spawn-timer') {
            if (e.timer <= framesPerHop) {
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
            if (e.jumping && e.destRow != null) {
                // Mid-jump: only the committed destination is dangerous
                danger[e.destRow + ',' + e.destCol] = true;
            } else {
                // Idle: both DL and DR are possible next hops
                if (isValidPos(er + 1, ec)) danger[(er + 1) + ',' + ec] = true;
                if (isValidPos(er + 1, ec + 1)) danger[(er + 1) + ',' + (ec + 1)] = true;
            }
            // Egg about to hatch into Coily — mark all adjacent tiles dangerous
            if (e.type === 'egg' && ((e.hops || 0) >= 5 || e.willHatch)) {
                // Egg about to hatch into Coily — mark all 4 adjacent tiles
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


// ─── Tour greedy planner ─────────────────────────────────────────────────────
var aiTour = [], aiTourIdx = 0, aiBoardSig = '';
var aiDetailPath = [], aiTourDots = [];

var aiRevertCounts = new Int8Array(POS_COUNT); // per-cube revert counter for toggle levels
var aiPrevCubeStates = null; // previous cube states to detect reverts
var aiCubeLastVisit = new Int32Array(POS_COUNT); // hop number when each cube was last stomped

function aiTourInit() {
    aiLastRemaining = 99; aiBestRemaining = 99; aiNoProgressCount = 0; aiStayCount = 0; aiSamePosCount = 0; aiPosHistory = [];
    aiRevertCounts = new Int8Array(POS_COUNT);
    aiPrevCubeStates = null;
    aiCubeLastVisit = new Int32Array(POS_COUNT);
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

// ─── Route-first AI: plan optimal path, validate safety via AND-OR tree ──────
// Philosophy: tour planner decides WHERE to go (optimal routing), AND-OR tree
// validates IF it's safe (can survive DEPTH hops against all enemy combos).

// Persistent memo: surviveOne and survive results are deterministic given state.
// Same (player, coily, enemy, depth) always gives same result. No need to clear
// between AI calls — entries from previous calls are still valid.
// Only clear when speed multiplier changes (timing parameters change).
var _persistMemo = new Map();
var _persistMemoSm = 0;
var _persistMemoCount = 0;

// ─── Precomputed danger tables (verified frame-accurate) ────────────────────
// Replaces expensive simStepForced enumeration with fast O(frames) lookups.

var DANGER_MAX_FRAMES = 320;
var LOOKAHEAD_DEPTH = 5;

function dangerAdd(table, frame, row, col, prob, maxFrames) {
    if (frame >= maxFrames) return;
    var idx = posToIdx[row * ROWS + col];
    if (idx >= 0) table[frame * POS_COUNT + idx] += prob;
}

// Per-path enemy representation: paths[i] = { prob, tiles, jumps }
// - tiles: Int8Array[maxFrames], posIdx of collision tile per frame (or -1).
// - jumps: array of {start, end, src, dest} — enemy jump segments for
//   cross-path swap detection.

// Recursively build all enemy paths. Each path stores tiles[] and jumps[].
// jumps[i] = {start, end, srcIdx, destIdx} — enemy's jump segments, used
// for cross-path (swap) collision detection.
function generatePaths(paths, currentTiles, currentJumps, type, row, col, jumping, jumpT, jumpDur,
                      moveTimer, moveInterval, hops, falling, willHatch,
                      spawnAnimTimer, destRow, destCol, dirBits,
                      frame, maxFrames, sm, prob) {
    if (frame >= maxFrames) {
        paths.push({ prob: prob, tiles: currentTiles.slice(), jumps: currentJumps.slice() });
        return;
    }
    if (falling) {
        if (jumping) {
            var newJT = jumpT + jumpDur;
            if (newJT < 0.33) {
                currentTiles[frame] = posToIdx[row * ROWS + col];
                generatePaths(paths, currentTiles, currentJumps, type, row, col, true, newJT, jumpDur,
                    moveTimer, moveInterval, hops, true, willHatch,
                    0, destRow, destCol, dirBits, frame + 1, maxFrames, sm, prob);
                currentTiles[frame] = -1;
            } else if (newJT < 0.67) {
                currentTiles[frame] = -1;
                generatePaths(paths, currentTiles, currentJumps, type, row, col, true, newJT, jumpDur,
                    moveTimer, moveInterval, hops, true, willHatch,
                    0, destRow, destCol, dirBits, frame + 1, maxFrames, sm, prob);
            } else {
                // Off-board, path ends; remaining frames -1
                for (var rf = frame; rf < maxFrames; rf++) currentTiles[rf] = -1;
                paths.push({ prob: prob, tiles: currentTiles.slice(), jumps: currentJumps.slice() });
            }
        } else {
            // Falling and not jumping: shouldn't happen, but finalize
            for (var rf2 = frame; rf2 < maxFrames; rf2++) currentTiles[rf2] = -1;
            paths.push({ prob: prob, tiles: currentTiles.slice(), jumps: currentJumps.slice() });
        }
        return;
    }
    if (spawnAnimTimer > 0) {
        currentTiles[frame] = -1;
        generatePaths(paths, currentTiles, currentJumps, type, row, col, jumping, jumpT, jumpDur,
            moveTimer, moveInterval, hops, falling, willHatch,
            spawnAnimTimer - 1, destRow, destCol, dirBits, frame + 1, maxFrames, sm, prob);
        return;
    }
    if (jumping) {
        var newJumpT = jumpT + jumpDur;
        if (newJumpT >= 1) {
            var landRow = destRow, landCol = destCol;
            if (!isValidPos(landRow, landCol)) {
                for (var rf3 = frame; rf3 < maxFrames; rf3++) currentTiles[rf3] = -1;
                paths.push({ prob: prob, tiles: currentTiles.slice(), jumps: currentJumps.slice() });
                return;
            }
            if (type === 'egg' && (hops >= 6 || landRow >= ROWS - 1 || willHatch)) {
                // Hatches into Coily: mark hatch + BFS flood
                var hopDur2 = Math.ceil(1.0 / jumpDur) + Math.round(moveInterval);
                for (var hf2 = frame; hf2 < frame + hopDur2 && hf2 < maxFrames; hf2++)
                    currentTiles[hf2] = posToIdx[landRow * ROWS + landCol];
                // Too complex for path-per-outcome; mark all reachable tiles
                // as "could be here" via conservative approx. This path ends here.
                for (var rf4 = frame + hopDur2; rf4 < maxFrames; rf4++) currentTiles[rf4] = -1;
                paths.push({ prob: prob, tiles: currentTiles.slice(), jumps: currentJumps.slice() });
                // Clear what we set
                for (var cf = frame; cf < frame + hopDur2 && cf < maxFrames; cf++) currentTiles[cf] = -1;
                return;
            }
            currentTiles[frame] = posToIdx[landRow * ROWS + landCol];
            generatePaths(paths, currentTiles, currentJumps, type, landRow, landCol, false, 0, jumpDur,
                0, moveInterval, hops, false, false,
                0, null, null, dirBits, frame + 1, maxFrames, sm, prob);
            currentTiles[frame] = -1;
        } else {
            if (newJumpT < 0.33) currentTiles[frame] = posToIdx[row * ROWS + col];
            else if (newJumpT >= 0.67 && destRow != null) currentTiles[frame] = posToIdx[destRow * ROWS + destCol];
            else currentTiles[frame] = -1;
            generatePaths(paths, currentTiles, currentJumps, type, row, col, true, newJumpT, jumpDur,
                moveTimer, moveInterval, hops, falling, willHatch,
                0, destRow, destCol, dirBits, frame + 1, maxFrames, sm, prob);
            currentTiles[frame] = -1;
        }
        return;
    }
    var newMoveTimer = moveTimer + 1;
    if (newMoveTimer < moveInterval) {
        currentTiles[frame] = posToIdx[row * ROWS + col];
        generatePaths(paths, currentTiles, currentJumps, type, row, col, false, 0, jumpDur,
            newMoveTimer, moveInterval, hops, false, willHatch,
            0, null, null, dirBits, frame + 1, maxFrames, sm, prob);
        currentTiles[frame] = -1;
        return;
    }
    currentTiles[frame] = posToIdx[row * ROWS + col];
    var _srcIdxF = posToIdx[row * ROWS + col];
    if (dirBits != null && (type === 'redball' || type === 'slick' || type === 'greenball')) {
        var nr, nc;
        if (dirBits & 1) { nr = row + 1; nc = col + 1; }
        else             { nr = row + 1; nc = col; }
        var newFall = !isValidPos(nr, nc);
        var _destIdxF = newFall ? -1 : posToIdx[nr * ROWS + nc];
        currentJumps.push({ start: frame + 1, srcIdx: _srcIdxF, destIdx: _destIdxF });
        generatePaths(paths, currentTiles, currentJumps, type, row, col, true, 0, jumpDur,
            0, moveInterval, hops + 1, newFall, false,
            0, nr, nc, dirBits >> 1, frame + 1, maxFrames, sm, prob);
        currentJumps.pop();
    } else {
        var choices = getMoveChoicesForType(type, row, col);
        if (choices.length === 0) {
            for (var rf5 = frame + 1; rf5 < maxFrames; rf5++) currentTiles[rf5] = -1;
            paths.push({ prob: prob, tiles: currentTiles.slice(), jumps: currentJumps.slice() });
        } else {
            var branchProb = prob / choices.length;
            for (var ci = 0; ci < choices.length; ci++) {
                var cnr = choices[ci][0], cnc = choices[ci][1];
                var cFall = !isValidPos(cnr, cnc);
                var cHops = hops + 1;
                var cWH = false;
                if (type === 'egg' && (cHops >= 6 || cnr >= ROWS - 1)) cWH = true;
                var cDestIdx = cFall ? -1 : posToIdx[cnr * ROWS + cnc];
                currentJumps.push({ start: frame + 1, srcIdx: _srcIdxF, destIdx: cDestIdx });
                generatePaths(paths, currentTiles, currentJumps, type, row, col, true, 0, jumpDur,
                    0, moveInterval, cHops, cFall, cWH,
                    0, cnr, cnc, null, frame + 1, maxFrames, sm, branchProb);
                currentJumps.pop();
            }
        }
    }
    currentTiles[frame] = -1;
}

// Partition paths by their tile at a specific frame.
// Returns { tile -> [path indices] } map.
function partitionPathsAtFrame(paths, pathIndices, frame) {
    var groups = {};
    for (var i = 0; i < pathIndices.length; i++) {
        var pi = pathIndices[i];
        var tile = paths[pi].tiles[frame];
        if (!groups[tile]) groups[tile] = [];
        groups[tile].push(pi);
    }
    return groups;
}

// Find the first frame in [fromFrame, toFrame) where paths diverge.
// Returns frame index or -1 if no divergence.
function findDivergenceFrame(paths, pathIndices, fromFrame, toFrame) {
    if (pathIndices.length <= 1) return -1;
    for (var f = fromFrame; f < toFrame; f++) {
        var firstTile = paths[pathIndices[0]].tiles[f];
        for (var i = 1; i < pathIndices.length; i++) {
            if (paths[pathIndices[i]].tiles[f] !== firstTile) return f;
        }
    }
    return -1;
}

function buildEnemyPaths(e, sm, maxFrames) {
    var paths = [];
    var scratch = new Int8Array(maxFrames);
    for (var i = 0; i < maxFrames; i++) scratch[i] = -1;
    var initialJumps = [];
    // If enemy starts in a jump, record it as initial jump
    if (e.jumping && e.destRow != null) {
        var iSrcIdx = posToIdx[e.row * ROWS + e.col];
        var iDestIdx = isValidPos(e.destRow, e.destCol) ? posToIdx[e.destRow * ROWS + e.destCol] : -1;
        initialJumps.push({ start: 0, srcIdx: iSrcIdx, destIdx: iDestIdx });
    }
    var jumpDur = e.jumpDur || ENEMY_JUMP_DUR * sm;
    var interval = e.moveInterval || enemyMoveInterval(e.type, sm);
    generatePaths(paths, scratch, initialJumps, e.type, e.row, e.col,
        !!e.jumping, e.jumpT || 0, jumpDur,
        e.moveTimer || 0, interval, e.hops || 0,
        !!e.falling, !!e.willHatch,
        e.spawnAnimTimer || 0,
        e.destRow != null ? e.destRow : null,
        e.destCol != null ? e.destCol : null,
        e.dirBits != null ? e.dirBits : null,
        0, maxFrames, sm, 1.0);
    return paths;
}

function buildSpawnPaths(forcedType, spawnDelay, sm, maxFrames) {
    var jumpDur = ENEMY_JUMP_DUR * sm;
    var interval = enemyMoveInterval(forcedType, sm);
    var allPaths = [];
    var scratch = new Int8Array(maxFrames);
    for (var i = 0; i < maxFrames; i++) scratch[i] = -1;
    if (forcedType === 'ugg') {
        generatePaths(allPaths, scratch, [], 'ugg', ROWS-1, ROWS, true, 0, jumpDur,
            0, interval, 0, false, false, 0, ROWS-1, ROWS-1, null,
            spawnDelay, maxFrames, sm, 1.0);
    } else if (forcedType === 'wrongway') {
        generatePaths(allPaths, scratch, [], 'wrongway', ROWS-1, -1, true, 0, jumpDur,
            0, interval, 0, false, false, 0, ROWS-1, 0, null,
            spawnDelay, maxFrames, sm, 1.0);
    } else {
        for (var sc = 0; sc < 2; sc++) {
            generatePaths(allPaths, scratch, [], forcedType, 1, sc, false, 0, jumpDur,
                0, interval, 0, false, false, 60, null, null, null,
                spawnDelay, maxFrames, sm, 0.5);
        }
    }
    return allPaths;
}

// P(enemy hits player) = sum of probs of paths that cross player timeline.
// Checks same-tile collision AND cross-path swap collision.
// playerJumps: array of {startFrame, endFrame, srcIdx, destIdx} — player hops.
function pathsHitProb(paths, playerIdx, playerJumps, startFrame, endFrame) {
    var hitSum = 0;
    for (var p = 0; p < paths.length; p++) {
        var tiles = paths[p].tiles;
        var hit = false;
        // Same-tile check
        for (var f = startFrame; f < endFrame; f++) {
            var pi = playerIdx[f];
            if (pi >= 0 && tiles[f] === pi) { hit = true; break; }
        }
        // Cross-path swap check
        if (!hit && playerJumps && playerJumps.length > 0) {
            var jumps = paths[p].jumps;
            if (jumps && jumps.length > 0) {
                for (var ej = 0; ej < jumps.length && !hit; ej++) {
                    var eJump = jumps[ej];
                    // enemy jump source/dest known. Duration ~= 1/jumpDur frames.
                    var eEnd = eJump.start + 30; // approx jump duration
                    for (var pj = 0; pj < playerJumps.length && !hit; pj++) {
                        var pJump = playerJumps[pj];
                        if (pJump.destIdx !== eJump.srcIdx || pJump.srcIdx !== eJump.destIdx) continue;
                        // Check temporal overlap
                        if (pJump.endFrame <= eJump.start || eEnd <= pJump.startFrame) continue;
                        hit = true;
                    }
                }
            }
        }
        if (hit) hitSum += paths[p].prob;
    }
    return hitSum;
}

function getMoveChoicesForType(type, row, col) {
    if (type === 'egg' || type === 'redball' || type === 'slick' || type === 'greenball')
        return [[row + 1, col], [row + 1, col + 1]];
    if (type === 'ugg')
        return [[row - 1, col - 1], [row, col - 1]];
    if (type === 'wrongway')
        return [[row - 1, col], [row, col + 1]];
    return [];
}

// Recursively expand enemy paths (branches on random moves).
// Main's timing: no idle frames after landing.
// dirBits (redball/slick/greenball): predetermined 7-bit path, consumed bit-by-bit.
function expandEnemyPaths(table, type, row, col, jumping, jumpT, jumpDur,
                          moveTimer, moveInterval, hops, falling, willHatch,
                          spawnAnimTimer, destRow, destCol, dirBits,
                          frame, maxFrames, sm, prob) {
    if (frame >= maxFrames) return;
    if (falling) {
        if (jumping) {
            var newJT = jumpT + jumpDur;
            if (newJT < 0.33) {
                dangerAdd(table, frame, row, col, prob, maxFrames);
                expandEnemyPaths(table, type, row, col, true, newJT, jumpDur,
                    moveTimer, moveInterval, hops, true, willHatch,
                    0, destRow, destCol, dirBits, frame + 1, maxFrames, sm, prob);
            } else if (newJT < 0.67) {
                expandEnemyPaths(table, type, row, col, true, newJT, jumpDur,
                    moveTimer, moveInterval, hops, true, willHatch,
                    0, destRow, destCol, dirBits, frame + 1, maxFrames, sm, prob);
            }
        }
        return;
    }
    if (spawnAnimTimer > 0) {
        expandEnemyPaths(table, type, row, col, jumping, jumpT, jumpDur,
            moveTimer, moveInterval, hops, falling, willHatch,
            spawnAnimTimer - 1, destRow, destCol, dirBits, frame + 1, maxFrames, sm, prob);
        return;
    }
    if (jumping) {
        var newJumpT = jumpT + jumpDur;
        if (newJumpT >= 1) {
            var landRow = destRow, landCol = destCol;
            if (!isValidPos(landRow, landCol)) return;
            if (type === 'egg' && (hops >= 6 || landRow >= ROWS - 1 || willHatch)) {
                // Egg hatches into Coily: BFS flood reachable tiles
                var hopDur = Math.ceil(1.0 / jumpDur) + Math.round(moveInterval);
                for (var hf = frame; hf < frame + hopDur && hf < maxFrames; hf++)
                    dangerAdd(table, hf, landRow, landCol, prob, maxFrames);
                var hatchReach = new Uint8Array(POS_COUNT);
                var hatchIdx = posToIdx[landRow * ROWS + landCol];
                var hatchQ = [];
                if (hatchIdx >= 0) { hatchReach[hatchIdx] = 1; hatchQ.push(hatchIdx); }
                var maxReach = Math.floor((maxFrames - frame) / hopDur);
                if (maxReach > 6) maxReach = 6;
                for (var rd = 0; rd < maxReach; rd++) {
                    var nextQ = [];
                    for (var qi = 0; qi < hatchQ.length; qi++) {
                        var adj = posAdj[hatchQ[qi]];
                        for (var ai = 0; ai < adj.length; ai++) {
                            if (!hatchReach[adj[ai]]) { hatchReach[adj[ai]] = 1; nextQ.push(adj[ai]); }
                        }
                    }
                    hatchQ = nextQ;
                    var reachFrame = frame + (rd + 1) * hopDur;
                    for (var pi = 0; pi < POS_COUNT; pi++) {
                        if (hatchReach[pi]) {
                            for (var ef = reachFrame; ef < maxFrames; ef++)
                                dangerAdd(table, ef, idxToPos[pi][0], idxToPos[pi][1], prob, maxFrames);
                        }
                    }
                }
                return;
            }
            dangerAdd(table, frame, landRow, landCol, prob, maxFrames);
            expandEnemyPaths(table, type, landRow, landCol, false, 0, jumpDur,
                0, moveInterval, hops, false, false,
                0, null, null, dirBits, frame + 1, maxFrames, sm, prob);
        } else {
            if (newJumpT < 0.33) dangerAdd(table, frame, row, col, prob, maxFrames);
            else if (newJumpT >= 0.67) {
                if (destRow != null) dangerAdd(table, frame, destRow, destCol, prob, maxFrames);
            }
            expandEnemyPaths(table, type, row, col, true, newJumpT, jumpDur,
                moveTimer, moveInterval, hops, falling, willHatch,
                0, destRow, destCol, dirBits, frame + 1, maxFrames, sm, prob);
        }
        return;
    }
    var newMoveTimer = moveTimer + 1;
    if (newMoveTimer < moveInterval) {
        dangerAdd(table, frame, row, col, prob, maxFrames);
        expandEnemyPaths(table, type, row, col, false, 0, jumpDur,
            newMoveTimer, moveInterval, hops, false, willHatch,
            0, null, null, dirBits, frame + 1, maxFrames, sm, prob);
        return;
    }
    // Deterministic path via dirBits (redball/slick/greenball): take exact direction
    dangerAdd(table, frame, row, col, prob, maxFrames);
    if (dirBits != null && (type === 'redball' || type === 'slick' || type === 'greenball')) {
        var nr, nc;
        if (dirBits & 1) { nr = row + 1; nc = col + 1; } // DR
        else             { nr = row + 1; nc = col; }     // DL
        var newFalling = !isValidPos(nr, nc);
        expandEnemyPaths(table, type, row, col, true, 0, jumpDur,
            0, moveInterval, hops + 1, newFalling, false,
            0, nr, nc, dirBits >> 1, frame + 1, maxFrames, sm, prob);
        return;
    }
    // Random path: branch on all choices
    var choices = getMoveChoicesForType(type, row, col);
    var branchProb = choices.length > 0 ? prob / choices.length : prob;
    for (var ci = 0; ci < choices.length; ci++) {
        var nr2 = choices[ci][0], nc2 = choices[ci][1];
        var newFalling2 = !isValidPos(nr2, nc2);
        var newHops = hops + 1;
        var newWH = false;
        if (type === 'egg' && (newHops >= 6 || nr2 >= ROWS - 1)) newWH = true;
        expandEnemyPaths(table, type, row, col, true, 0, jumpDur,
            0, moveInterval, newHops, newFalling2, newWH,
            0, nr2, nc2, null, frame + 1, maxFrames, sm, branchProb);
    }
}

function buildEnemyDangerTable(e, sm, maxFrames) {
    var table = new Float32Array(maxFrames * POS_COUNT);
    var jumpDur = e.jumpDur || ENEMY_JUMP_DUR * sm;
    var interval = e.moveInterval || enemyMoveInterval(e.type, sm);
    expandEnemyPaths(table, e.type, e.row, e.col,
        !!e.jumping, e.jumpT || 0, jumpDur,
        e.moveTimer || 0, interval, e.hops || 0,
        !!e.falling, !!e.willHatch,
        e.spawnAnimTimer || 0,
        e.destRow != null ? e.destRow : null,
        e.destCol != null ? e.destCol : null,
        e.dirBits != null ? e.dirBits : null,
        0, maxFrames, sm, 1.0);
    return table;
}

// Coily danger table: ROM grid-word algorithm (deterministic).
// targetTimeline[f] = {row, col} for Coily's chase target at frame f.
function buildCoilyDangerTable(e, targetTimeline, sm, maxFrames) {
    var table = new Float32Array(maxFrames * POS_COUNT);
    var jumpDur = e.jumpDur || ENEMY_JUMP_DUR * sm;
    var interval = e.moveInterval || enemyMoveInterval('coily', sm);
    var row = e.row, col = e.col;
    var jumping = !!e.jumping, jumpT = e.jumpT || 0;
    var moveTimer = e.moveTimer || 0;
    var destRow = e.destRow, destCol = e.destCol;
    var spawnAnimTimer = e.spawnAnimTimer || 0;

    for (var f = 0; f < maxFrames; f++) {
        if (spawnAnimTimer > 0) { spawnAnimTimer--; continue; }
        if (jumping) {
            jumpT += jumpDur;
            if (jumpT >= 1) {
                jumping = false; row = destRow; col = destCol;
                if (!isValidPos(row, col)) break;
                dangerAdd(table, f, row, col, 1.0, maxFrames);
                continue;
            }
            if (jumpT < 0.33) dangerAdd(table, f, row, col, 1.0, maxFrames);
            else if (jumpT >= 0.67 && destRow != null) dangerAdd(table, f, destRow, destCol, 1.0, maxFrames);
            continue;
        }
        moveTimer++;
        if (moveTimer < interval) { dangerAdd(table, f, row, col, 1.0, maxFrames); continue; }
        moveTimer = 0;
        // ROM grid-word chase: target = prev, EXCEPT if Coily at prev → target = cur
        var tgt = targetTimeline[f] || targetTimeline[0];
        var targetR, targetC;
        if (row === tgt.prev.row && col === tgt.prev.col) {
            targetR = tgt.cur.row; targetC = tgt.cur.col;
        } else {
            targetR = tgt.prev.row; targetC = tgt.prev.col;
        }
        var c_gw1 = row - col + 1;
        var t_gw1 = targetR - targetC + 1;
        var enr, enc;
        if (targetR > row) {
            if (t_gw1 > c_gw1) { enr = row + 1; enc = col; }
            else { enr = row + 1; enc = col + 1; }
        } else {
            if (t_gw1 < c_gw1) { enr = row - 1; enc = col; }
            else { enr = row - 1; enc = col - 1; }
        }
        dangerAdd(table, f, row, col, 1.0, maxFrames);
        destRow = enr; destCol = enc; jumping = true; jumpT = 0;
        if (!isValidPos(enr, enc)) break;
    }
    return table;
}

function buildSpawnDangerTable(forcedType, spawnDelay, sm, maxFrames) {
    var jumpDur = ENEMY_JUMP_DUR * sm;
    var interval = enemyMoveInterval(forcedType, sm);
    if (forcedType === 'ugg') {
        var t = new Float32Array(maxFrames * POS_COUNT);
        expandEnemyPaths(t, 'ugg', ROWS-1, ROWS, true, 0, jumpDur,
            0, interval, 0, false, false, 0, ROWS-1, ROWS-1, null,
            spawnDelay, maxFrames, sm, 1.0);
        return [t];
    }
    if (forcedType === 'wrongway') {
        var t = new Float32Array(maxFrames * POS_COUNT);
        expandEnemyPaths(t, 'wrongway', ROWS-1, -1, true, 0, jumpDur,
            0, interval, 0, false, false, 0, ROWS-1, 0, null,
            spawnDelay, maxFrames, sm, 1.0);
        return [t];
    }
    var tables = [];
    for (var sc = 0; sc < 2; sc++) {
        var t = new Float32Array(maxFrames * POS_COUNT);
        expandEnemyPaths(t, forcedType, 1, sc, false, 0, jumpDur,
            0, interval, 0, false, false, 60, null, null, null,
            spawnDelay, maxFrames, sm, 0.5);
        tables.push(t);
    }
    return tables;
}

// P(survive this enemy) = 1 - max P(enemy at player tile at any frame).
// Using max (not product) correctly handles the correlation: a single enemy
// at the same tile across multiple frames is ONE path, not independent events.
function tableSurvivalProb(playerIdx, dangerTable, startFrame, endFrame) {
    var maxHit = 0;
    for (var f = startFrame; f < endFrame; f++) {
        var pi = playerIdx[f];
        if (pi >= 0) {
            var hitProb = dangerTable[f * POS_COUNT + pi];
            if (hitProb > maxHit) maxHit = hitProb;
            if (maxHit >= 1.0) return 0;
        }
    }
    return 1.0 - maxHit;
}

// Append one player hop to shared mutable timeline.
function appendHop(result, pRow, pCol, dir, sm, startFrame, maxFrames) {
    if (dir === 'STAY') {
        var srcIdx = posToIdx[pRow * ROWS + pCol];
        var stayLen = Math.ceil(1.0 / (PLAYER_JUMP_DUR * sm)) + 4;
        var endF = Math.min(startFrame + stayLen, maxFrames);
        for (var f = startFrame; f < endF; f++) result[f] = srcIdx;
        return { endFrame: endF, endRow: pRow, endCol: pCol, landFrame: -1 };
    }
    var d = DIRS[dir];
    var destR = pRow + d.dr, destC = pCol + d.dc;
    if (!isValidPos(destR, destC)) return null;
    var srcIdx = posToIdx[pRow * ROWS + pCol];
    var dstIdx = posToIdx[destR * ROWS + destC];
    var jumpDur = PLAYER_JUMP_DUR * sm;
    var jumpT = 0, landed = false, postLand = 0, landFrame = -1;
    for (var f = startFrame; f < maxFrames; f++) {
        if (!landed) {
            jumpT += jumpDur;
            if (jumpT >= 1) { landed = true; landFrame = f; result[f] = dstIdx; continue; }
            if (jumpT < 0.33) result[f] = srcIdx;
            else if (jumpT >= 0.67) result[f] = dstIdx;
        } else {
            result[f] = dstIdx;
            postLand++;
            if (postLand >= 2) return { endFrame: f + 1, endRow: destR, endCol: destC, landFrame: landFrame };
        }
    }
    return { endFrame: maxFrames, endRow: destR, endCol: destC, landFrame: landFrame };
}

// Build per-frame Coily chase target timeline.
// Coily chases player's PREVIOUS position, EXCEPT if Coily is AT prev,
// then chases CURRENT. Returns per-frame {prev, cur} pair.
function buildCoilyTargetTimeline(waypoints, initialPrevRow, initialPrevCol, maxFrames) {
    var timeline = new Array(maxFrames);
    var curPrev = { row: initialPrevRow, col: initialPrevCol };
    var curCur = { row: waypoints[0].row, col: waypoints[0].col };
    var curWp = 0;
    for (var f = 0; f < maxFrames; f++) {
        while (curWp + 1 < waypoints.length && waypoints[curWp + 1].frame <= f) {
            curPrev = { row: waypoints[curWp].row, col: waypoints[curWp].col };
            curCur = { row: waypoints[curWp + 1].row, col: waypoints[curWp + 1].col };
            curWp++;
        }
        timeline[f] = { prev: curPrev, cur: curCur };
    }
    return timeline;
}

// Build Coily's deterministic path as a single tile-per-frame array.
function buildCoilyPath(e, targetTimeline, sm, maxFrames) {
    var tiles = new Int8Array(maxFrames);
    for (var i = 0; i < maxFrames; i++) tiles[i] = -1;
    var jumpDur = e.jumpDur || ENEMY_JUMP_DUR * sm;
    var interval = e.moveInterval || enemyMoveInterval('coily', sm);
    var row = e.row, col = e.col;
    var jumping = !!e.jumping, jumpT = e.jumpT || 0;
    var moveTimer = e.moveTimer || 0;
    var destRow = e.destRow, destCol = e.destCol;
    var spawnAnimTimer = e.spawnAnimTimer || 0;
    for (var f = 0; f < maxFrames; f++) {
        if (spawnAnimTimer > 0) { spawnAnimTimer--; continue; }
        if (jumping) {
            jumpT += jumpDur;
            if (jumpT >= 1) {
                jumping = false; row = destRow; col = destCol;
                if (!isValidPos(row, col)) break;
                tiles[f] = posToIdx[row * ROWS + col];
                continue;
            }
            if (jumpT < 0.33) tiles[f] = posToIdx[row * ROWS + col];
            else if (jumpT >= 0.67 && destRow != null) tiles[f] = posToIdx[destRow * ROWS + destCol];
            continue;
        }
        moveTimer++;
        if (moveTimer < interval) { tiles[f] = posToIdx[row * ROWS + col]; continue; }
        moveTimer = 0;
        var tgt = targetTimeline[f] || targetTimeline[0];
        var targetR, targetC;
        if (row === tgt.prev.row && col === tgt.prev.col) {
            targetR = tgt.cur.row; targetC = tgt.cur.col;
        } else {
            targetR = tgt.prev.row; targetC = tgt.prev.col;
        }
        var c_gw1 = row - col + 1;
        var t_gw1 = targetR - targetC + 1;
        var enr, enc;
        if (targetR > row) {
            if (t_gw1 > c_gw1) { enr = row + 1; enc = col; }
            else { enr = row + 1; enc = col + 1; }
        } else {
            if (t_gw1 < c_gw1) { enr = row - 1; enc = col; }
            else { enr = row - 1; enc = col - 1; }
        }
        tiles[f] = posToIdx[row * ROWS + col];
        destRow = enr; destCol = enc; jumping = true; jumpT = 0;
        if (!isValidPos(enr, enc)) break;
    }
    return tiles;
}

// Reactive expectimax using per-path data. At each depth:
//   - For each player dir, compute P(survive hop) from enemy path subsets.
//   - Partition each enemy's subset by its outcome during this hop.
//   - Enumerate combos, recurse weighted, max over dirs.
// Returns { dir -> best reactive survival } for hop-1 directions.
function findReactiveSurvival(gs, enemyPathLists, coilyInit, startFrame, maxFrames, lookaheadDepth) {
    var LOOKAHEAD = lookaheadDepth || LOOKAHEAD_DEPTH;
    var sm = gs.sm;
    var pRow = gs.player.row, pCol = gs.player.col;
    var timeline = new Int8Array(maxFrames);
    for (var i = 0; i < maxFrames; i++) timeline[i] = -1;
    var waypoints = [{ frame: 0, row: pRow, col: pCol }];
    var playerJumps = [];

    // Compute totalProb of each enemy's path subset (for normalization).
    function subsetTotalProb(enemyIdx, pathIndices) {
        var s = 0, paths = enemyPathLists[enemyIdx];
        for (var i = 0; i < pathIndices.length; i++) s += paths[pathIndices[i]].prob;
        return s;
    }

    // P(enemy hits player hop | enemy is on one of pathIndices).
    function enemyHitProb(enemyIdx, pathIndices, startF, endF) {
        var paths = enemyPathLists[enemyIdx];
        var hitSum = 0;
        for (var i = 0; i < pathIndices.length; i++) {
            var path = paths[pathIndices[i]];
            var tiles = path.tiles;
            var hit = false;
            for (var f = startF; f < endF; f++) {
                var pi = timeline[f];
                if (pi >= 0 && tiles[f] === pi) { hit = true; break; }
            }
            if (!hit && playerJumps.length > 0 && path.jumps && path.jumps.length > 0) {
                for (var ej = 0; ej < path.jumps.length && !hit; ej++) {
                    var eJump = path.jumps[ej];
                    var eEnd = eJump.start + 30;
                    for (var pj = 0; pj < playerJumps.length && !hit; pj++) {
                        var pJump = playerJumps[pj];
                        if (pJump.destIdx !== eJump.srcIdx || pJump.srcIdx !== eJump.destIdx) continue;
                        if (pJump.endFrame <= eJump.start || eEnd <= pJump.startFrame) continue;
                        hit = true;
                    }
                }
            }
            if (hit) hitSum += path.prob;
        }
        return hitSum;
    }

    // Simulate Coily for a range of frames given current waypoints.
    // Returns new state + whether Coily killed player.
    var initialPrev = {
        row: gs.player.prevRow != null ? gs.player.prevRow : pRow,
        col: gs.player.prevCol != null ? gs.player.prevCol : pCol
    };
    function simulateCoily(cState, fromFrame, toFrame) {
        var jumpDur = cState.jumpDur;
        var interval = cState.interval;
        var row = cState.row, col = cState.col;
        var jumping = cState.jumping, jumpT = cState.jumpT;
        var moveTimer = cState.moveTimer;
        var destRow = cState.destRow, destCol = cState.destCol;
        var dead = cState.dead, killsPlayer = false;

        for (var f = fromFrame; f < toFrame && !dead; f++) {
            var pi = timeline[f];
            var cTile = -1;
            if (jumping) {
                if (jumpT < 0.33) cTile = posToIdx[row * ROWS + col];
                else if (jumpT >= 0.67 && destRow != null) cTile = posToIdx[destRow * ROWS + destCol];
            } else {
                cTile = posToIdx[row * ROWS + col];
            }
            if (pi >= 0 && cTile === pi) { killsPlayer = true; break; }

            if (jumping) {
                jumpT += jumpDur;
                if (jumpT >= 1) {
                    jumping = false; row = destRow; col = destCol;
                    if (!isValidPos(row, col)) { dead = true; break; }
                }
                continue;
            }
            moveTimer++;
            if (moveTimer < interval) continue;
            moveTimer = 0;
            // Coily target: prev = source of most recent non-STAY hop triggered
            // at/before frame f (simTryMove sets prev=row on hop start), cur =
            // player position at frame f (updated at waypoint landFrame).
            var prev;
            var mostRecent = -1;
            for (var pjw = playerJumps.length - 1; pjw >= 0; pjw--) {
                if (playerJumps[pjw].startFrame <= f) { mostRecent = pjw; break; }
            }
            if (mostRecent >= 0) {
                var sPos = idxToPos[playerJumps[mostRecent].srcIdx];
                prev = { row: sPos[0], col: sPos[1] };
            } else {
                prev = initialPrev;
            }
            var cur = waypoints[0];
            for (var w = 1; w < waypoints.length; w++) {
                if (waypoints[w].frame <= f) cur = waypoints[w];
                else break;
            }
            var targetR, targetC;
            if (row === prev.row && col === prev.col) { targetR = cur.row; targetC = cur.col; }
            else { targetR = prev.row; targetC = prev.col; }
            var c_gw1 = row - col + 1;
            var t_gw1 = targetR - targetC + 1;
            var enr, enc;
            if (targetR > row) {
                if (t_gw1 > c_gw1) { enr = row + 1; enc = col; }
                else { enr = row + 1; enc = col + 1; }
            } else {
                if (t_gw1 < c_gw1) { enr = row - 1; enc = col; }
                else { enr = row - 1; enc = col - 1; }
            }
            destRow = enr; destCol = enc; jumping = true; jumpT = 0;
            // Check cross-path swap collision (ROM $BD1E): Coily and player
            // swapping tiles mid-jump = death.
            var cSrcIdx = posToIdx[row * ROWS + col];
            var cDestIdx = isValidPos(enr, enc) ? posToIdx[enr * ROWS + enc] : -1;
            if (cDestIdx >= 0) {
                var cEnd = f + Math.ceil(1.0 / jumpDur) + 1;
                for (var pjs = 0; pjs < playerJumps.length && !killsPlayer; pjs++) {
                    var pJ = playerJumps[pjs];
                    if (pJ.destIdx !== cSrcIdx || pJ.srcIdx !== cDestIdx) continue;
                    if (pJ.endFrame <= f || cEnd <= pJ.startFrame) continue;
                    killsPlayer = true;
                }
                if (killsPlayer) break;
            }
            if (!isValidPos(enr, enc)) { dead = true; break; }
        }
        return { row: row, col: col, jumping: jumping, jumpT: jumpT,
                 moveTimer: moveTimer, destRow: destRow, destCol: destCol,
                 jumpDur: jumpDur, interval: interval, dead: dead, killsPlayer: killsPlayer };
    }

    // Recursive reactive expectimax.
    // enemySubsets[i] = array of path indices for enemy i that are still possible.
    function reactive(curRow, curCol, depth, curFrame, enemySubsets, coilyState) {
        if (depth >= LOOKAHEAD || curFrame >= maxFrames) return 1.0;

        var best = 0;
        for (var dk = 0; dk < DIR_KEYS_WITH_STAY.length; dk++) {
            var dir = DIR_KEYS_WITH_STAY[dk];
            if (dir !== 'STAY' && !isValidPos(curRow + DIRS[dir].dr, curCol + DIRS[dir].dc)) continue;
            var hop = appendHop(timeline, curRow, curCol, dir, sm, curFrame, maxFrames);
            if (!hop) continue;
            if (hop.landFrame >= 0)
                waypoints.push({ frame: hop.landFrame, row: hop.endRow, col: hop.endCol });
            var pushedJ = false;
            if (dir !== 'STAY') {
                playerJumps.push({ startFrame: curFrame, endFrame: hop.endFrame,
                    srcIdx: posToIdx[curRow * ROWS + curCol],
                    destIdx: posToIdx[hop.endRow * ROWS + hop.endCol] });
                pushedJ = true;
            }

            // Check Coily first (deterministic)
            var newCoily = coilyState;
            var coilyOk = true;
            if (coilyState && !coilyState.dead) {
                newCoily = simulateCoily(coilyState, curFrame, hop.endFrame);
                if (newCoily.killsPlayer) coilyOk = false;
            }

            if (coilyOk) {
                // Partition each enemy's subset by divergence during this hop.
                var partitions = [];
                for (var ei2 = 0; ei2 < enemyPathLists.length; ei2++) {
                    var subset = enemySubsets[ei2];
                    if (subset.length <= 1) {
                        partitions.push([subset]);
                        continue;
                    }
                    var divFrame = findDivergenceFrame(enemyPathLists[ei2], subset, curFrame, hop.endFrame);
                    if (divFrame < 0) {
                        partitions.push([subset]);
                    } else {
                        var groups = partitionPathsAtFrame(enemyPathLists[ei2], subset, divFrame);
                        var subsetList = [];
                        for (var k in groups) subsetList.push(groups[k]);
                        partitions.push(subsetList);
                    }
                }

                // Cartesian product of partitions — compute per-combo survival × future
                var comboCount = 1;
                for (var ei3 = 0; ei3 < partitions.length; ei3++) comboCount *= partitions[ei3].length;

                var combined = 0;
                for (var c = 0; c < comboCount; c++) {
                    var newSubsets = [];
                    var comboProb = 1.0;
                    var cc = c;
                    for (var ei4 = 0; ei4 < partitions.length; ei4++) {
                        var pi = cc % partitions[ei4].length;
                        cc = (cc / partitions[ei4].length) | 0;
                        var subsetSel = partitions[ei4][pi];
                        newSubsets.push(subsetSel);
                        var totalAll = subsetTotalProb(ei4, enemySubsets[ei4]);
                        var totalSel = subsetTotalProb(ei4, subsetSel);
                        comboProb *= (totalAll > 0 ? totalSel / totalAll : 1);
                    }
                    // Per-combo survival: does ANY path in new_subsets hit player hop?
                    // Within a subset, paths share the same choice during this hop,
                    // so they all hit or all don't hit (if divergence was only in this hop).
                    // But subsequent choices still diverge, so some sub-paths may/may not hit.
                    var perComboSurvive = 1.0;
                    for (var ei5 = 0; ei5 < newSubsets.length; ei5++) {
                        var totSel = subsetTotalProb(ei5, newSubsets[ei5]);
                        if (totSel <= 0) continue;
                        var hitSel = enemyHitProb(ei5, newSubsets[ei5], curFrame, hop.endFrame);
                        perComboSurvive *= (1.0 - hitSel / totSel);
                        if (perComboSurvive <= 0) break;
                    }
                    if (perComboSurvive > 0) {
                        var future = reactive(hop.endRow, hop.endCol, depth + 1, hop.endFrame, newSubsets, newCoily);
                        combined += comboProb * perComboSurvive * future;
                    }
                }

                if (combined > best) best = combined;
            }

            if (pushedJ) playerJumps.pop();
            if (hop.landFrame >= 0) waypoints.pop();
            for (var f = curFrame; f < hop.endFrame && f < maxFrames; f++) timeline[f] = -1;
            if (best >= 0.99) break;
        }
        return best;
    }

    // Initial subsets: all paths active.
    var initialSubsets = [];
    for (var i2 = 0; i2 < enemyPathLists.length; i2++) {
        var allIdx = [];
        for (var pi = 0; pi < enemyPathLists[i2].length; pi++) allIdx.push(pi);
        initialSubsets.push(allIdx);
    }

    // Initial Coily state
    var initialCoily = null;
    if (coilyInit) {
        initialCoily = {
            row: coilyInit.row, col: coilyInit.col,
            jumping: !!coilyInit.jumping, jumpT: coilyInit.jumpT || 0,
            moveTimer: coilyInit.moveTimer || 0,
            destRow: coilyInit.destRow != null ? coilyInit.destRow : null,
            destCol: coilyInit.destCol != null ? coilyInit.destCol : null,
            jumpDur: coilyInit.jumpDur || ENEMY_JUMP_DUR * sm,
            interval: coilyInit.moveInterval || enemyMoveInterval('coily', sm),
            dead: false
        };
    }

    // Top-level: for each dir1, compute reactive value.
    var bestPerDir = {};
    for (var dk = 0; dk < DIR_KEYS_WITH_STAY.length; dk++) {
        var dir1 = DIR_KEYS_WITH_STAY[dk];
        if (dir1 !== 'STAY' && !isValidPos(pRow + DIRS[dir1].dr, pCol + DIRS[dir1].dc)) continue;
        // Use the reactive function starting at depth 0
        // We need to treat dir1 as already-chosen
        // Wrap it: extend timeline with dir1, then recurse for depths 1..LOOKAHEAD
        var hop1 = appendHop(timeline, pRow, pCol, dir1, gs.sm, 0, maxFrames);
        if (!hop1) continue;
        if (hop1.landFrame >= 0)
            waypoints.push({ frame: hop1.landFrame, row: hop1.endRow, col: hop1.endCol });
        if (dir1 !== 'STAY') {
            playerJumps.push({ startFrame: 0, endFrame: hop1.endFrame,
                srcIdx: posToIdx[pRow * ROWS + pCol],
                destIdx: posToIdx[hop1.endRow * ROWS + hop1.endCol] });
        }

        // Check Coily hop1
        var newCoily1 = initialCoily;
        var coilyOk = true;
        if (initialCoily && !initialCoily.dead) {
            newCoily1 = simulateCoily(initialCoily, startFrame, hop1.endFrame);
            if (newCoily1.killsPlayer) coilyOk = false;
        }

        if (coilyOk) {
            // Partition subsets by choices during hop 1
            var partitions = [];
            for (var ei2 = 0; ei2 < enemyPathLists.length; ei2++) {
                var subset = initialSubsets[ei2];
                if (subset.length <= 1) { partitions.push([subset]); continue; }
                var divFrame = findDivergenceFrame(enemyPathLists[ei2], subset, startFrame, hop1.endFrame);
                if (divFrame < 0) { partitions.push([subset]); }
                else {
                    var groups = partitionPathsAtFrame(enemyPathLists[ei2], subset, divFrame);
                    var subsetList = [];
                    for (var k in groups) subsetList.push(groups[k]);
                    partitions.push(subsetList);
                }
            }
            var comboCount = 1;
            for (var ei3 = 0; ei3 < partitions.length; ei3++) comboCount *= partitions[ei3].length;
            var combined = 0;
            for (var c = 0; c < comboCount; c++) {
                var newSubsets = [];
                var comboProb = 1.0;
                var cc = c;
                for (var ei4 = 0; ei4 < partitions.length; ei4++) {
                    var pIdx = cc % partitions[ei4].length;
                    cc = (cc / partitions[ei4].length) | 0;
                    var subsetSel = partitions[ei4][pIdx];
                    newSubsets.push(subsetSel);
                    var totalAll = subsetTotalProb(ei4, initialSubsets[ei4]);
                    var totalSel = subsetTotalProb(ei4, subsetSel);
                    comboProb *= (totalAll > 0 ? totalSel / totalAll : 1);
                }
                // Per-combo survival
                var perComboSurvive = 1.0;
                for (var ei5 = 0; ei5 < newSubsets.length; ei5++) {
                    var totSel = subsetTotalProb(ei5, newSubsets[ei5]);
                    if (totSel <= 0) continue;
                    var hitSel = enemyHitProb(ei5, newSubsets[ei5], startFrame, hop1.endFrame);
                    perComboSurvive *= (1.0 - hitSel / totSel);
                    if (perComboSurvive <= 0) break;
                }
                if (perComboSurvive > 0) {
                    var future = reactive(hop1.endRow, hop1.endCol, 1, hop1.endFrame, newSubsets, newCoily1);
                    combined += comboProb * perComboSurvive * future;
                }
            }
            bestPerDir[dir1] = combined;
        } else {
            bestPerDir[dir1] = 0;
        }

        if (dir1 !== 'STAY') playerJumps.pop();
        if (hop1.landFrame >= 0) waypoints.pop();
        for (var f = 0; f < hop1.endFrame && f < maxFrames; f++) timeline[f] = -1;
    }
    return bestPerDir;
}

// Tree search: for each first direction, find the best N-hop survival probability.
function findMultiHopSurvival(gs, enemyPathLists, coilyInit, startFrame, maxFrames, lookaheadDepth) {
    var LOOKAHEAD = lookaheadDepth || LOOKAHEAD_DEPTH;
    var sm = gs.sm;
    var pRow = gs.player.row, pCol = gs.player.col;
    var timeline = new Int8Array(maxFrames);
    for (var i = 0; i < maxFrames; i++) timeline[i] = -1;
    var waypoints = [{ frame: 0, row: pRow, col: pCol }];
    var playerJumps = []; // stack of {startFrame, endFrame, srcIdx, destIdx} for current path

    // Per-enemy survival: P(survive enemy_i) = 1 - sum(path probs that cross player)
    function computeSurvival(startF, endF, includeCoily, needCoily) {
        var surv = 1.0;
        for (var t = 0; t < enemyPathLists.length; t++) {
            var hit = pathsHitProb(enemyPathLists[t], timeline, playerJumps, startF, endF);
            surv *= (1.0 - hit);
            if (surv <= 0) return 0;
        }
        if (includeCoily && coilyInit) {
            var prevR = gs.player.prevRow != null ? gs.player.prevRow : pRow;
            var prevC = gs.player.prevCol != null ? gs.player.prevCol : pCol;
            var targetTL = buildCoilyTargetTimeline(waypoints, prevR, prevC, endF);
            var cPath = buildCoilyPath(coilyInit, targetTL, sm, endF);
            // Coily is deterministic single path — check tile match
            for (var f = startF; f < endF; f++) {
                var pi = timeline[f];
                if (pi >= 0 && cPath[f] === pi) { surv = 0; break; }
            }
        }
        return surv;
    }

    function search(curRow, curCol, depth, curFrame) {
        if (depth >= LOOKAHEAD || curFrame >= maxFrames) {
            var curIdx = posToIdx[curRow * ROWS + curCol];
            var extEnd = Math.min(curFrame + 40, maxFrames);
            for (var ef = curFrame; ef < extEnd; ef++) timeline[ef] = curIdx;
            var leafSurv = computeSurvival(startFrame, extEnd, true);
            for (var ef2 = curFrame; ef2 < extEnd; ef2++) timeline[ef2] = -1;
            return leafSurv;
        }

        var best = 0;
        for (var dk = 0; dk < DIR_KEYS_WITH_STAY.length; dk++) {
            var dir = DIR_KEYS_WITH_STAY[dk];
            if (dir !== 'STAY' && !isValidPos(curRow + DIRS[dir].dr, curCol + DIRS[dir].dc)) continue;
            var hop = appendHop(timeline, curRow, curCol, dir, sm, curFrame, maxFrames);
            if (!hop) continue;
            if (hop.landFrame >= 0)
                waypoints.push({ frame: hop.landFrame, row: hop.endRow, col: hop.endCol });
            // Record player's jump segment (skip STAY)
            var pushedJump = false;
            if (dir !== 'STAY') {
                var pSrcIdx = posToIdx[curRow * ROWS + curCol];
                var pDestIdx = posToIdx[hop.endRow * ROWS + hop.endCol];
                playerJumps.push({ startFrame: curFrame, endFrame: hop.endFrame, srcIdx: pSrcIdx, destIdx: pDestIdx });
                pushedJump = true;
            }

            // Check survival over full path [startFrame..hop.endFrame]
            var sofar = computeSurvival(startFrame, hop.endFrame, true);
            if (sofar > 0) {
                var s = search(hop.endRow, hop.endCol, depth + 1, hop.endFrame);
                if (s > best) best = s;
            }

            if (pushedJump) playerJumps.pop();
            if (hop.landFrame >= 0) waypoints.pop();
            for (var f = curFrame; f < hop.endFrame && f < maxFrames; f++) timeline[f] = -1;
            if (best >= 0.99) break;
        }
        return best;
    }

    var bestPerDir = {};
    for (var dk = 0; dk < DIR_KEYS_WITH_STAY.length; dk++) {
        var dir1 = DIR_KEYS_WITH_STAY[dk];
        if (dir1 !== 'STAY' && !isValidPos(pRow + DIRS[dir1].dr, pCol + DIRS[dir1].dc)) continue;
        var hop1 = appendHop(timeline, pRow, pCol, dir1, gs.sm, 0, maxFrames);
        if (!hop1) continue;
        if (hop1.landFrame >= 0)
            waypoints.push({ frame: hop1.landFrame, row: hop1.endRow, col: hop1.endCol });
        // Record player's first jump
        var pushed1 = false;
        if (dir1 !== 'STAY') {
            var p1SrcIdx = posToIdx[pRow * ROWS + pCol];
            var p1DestIdx = posToIdx[hop1.endRow * ROWS + hop1.endCol];
            playerJumps.push({ startFrame: 0, endFrame: hop1.endFrame, srcIdx: p1SrcIdx, destIdx: p1DestIdx });
            pushed1 = true;
        }

        var hop1Surv = computeSurvival(startFrame, hop1.endFrame, true);
        if (hop1Surv > 0) {
            bestPerDir[dir1] = search(hop1.endRow, hop1.endCol, 1, hop1.endFrame);
        } else {
            bestPerDir[dir1] = 0;
        }

        if (pushed1) playerJumps.pop();
        if (hop1.landFrame >= 0) waypoints.pop();
        for (var f = 0; f < hop1.endFrame && f < maxFrames; f++) timeline[f] = -1;
    }
    return bestPerDir;
}

function unifiedPick(gs, coilyActive) {
    var _perfStart = typeof performance !== 'undefined' ? performance.now() : 0;
    var savedRng = simRng;
    var baseSeed = (gs.player.row * 7 + gs.player.col) * 10000 + (frameCount || 0);
    function simSeed(sampleIdx) { simRng = createSeededRng(baseSeed + sampleIdx * 9973); }
    function restoreRng() { simRng = savedRng; }

    // Reset prediction timeline for validation harness
    window.aiPredictedTimeline = null;

    var hasEnemies = gs.enemies.length > 0;
    // Adaptive depth: at higher speed multipliers, each hop is fewer frames
    // so the tree is cheaper per depth level. Scale max depth with sm to
    // maintain similar wall-clock horizon coverage across levels.
    var baseDepth = window.AI_DEPTH || Math.min(20, Math.round(8 * gs.sm));
    var DEPTH = hasEnemies ? baseDepth : 0;

    var pJumpDur = PLAYER_JUMP_DUR * gs.sm;
    var pJumpFrames = Math.ceil(1 / pJumpDur);
    var cJumpDur = ENEMY_JUMP_DUR * gs.sm;
    var cIdleFrames = enemyMoveInterval('coily', gs.sm);

    // Time budget: cap AI computation to avoid frame drops
    var _aiStartTime = typeof performance !== 'undefined' ? performance.now() : 0;
    var _aiDeadline = _aiStartTime + 80; // total budget
    var _dirDeadline = Infinity; // per-direction deadline, set in direction loop

    // Cross-timestep memo: persist across AI calls, clear on speed change or overflow
    if (gs.sm !== _persistMemoSm || _persistMemoCount > 50000) {
        _persistMemo = new Map(); _persistMemoSm = gs.sm; _persistMemoCount = 0;
    }
    var memo = _persistMemo;

    // ── Collect non-Coily enemy states ──
    var coilyInit = null;
    var enemyInits = [];
    for (var ei = 0; ei < gs.enemies.length; ei++) {
        var e = gs.enemies[ei];
        if (e.type === 'coily') {
            coilyInit = { row: e.row, col: e.col, jumping: !!e.jumping,
                jumpT: e.jumpT || 0, moveTimer: e.moveTimer || 0,
                destRow: e.destRow, destCol: e.destCol,
                lureRow: e.lureRow != null ? e.lureRow : null,
                lureCol: e.lureCol != null ? e.lureCol : null };
            continue;
        }
        if (e.type === 'slick' || e.type === 'greenball') continue;
        if (e.type === 'spawn-timer') {
            // Convert spawn-timer to the enemy it will produce
            if (e.timer > DEPTH * pJumpFrames + 50) continue; // too far in the future
            var ft = e.forcedType;
            if (!ft) {
                var hasCoilyOrEgg = false;
                for (var sti = 0; sti < gs.enemies.length; sti++)
                    if (gs.enemies[sti].type === 'coily' || gs.enemies[sti].type === 'egg') { hasCoilyOrEgg = true; break; }
                ft = hasCoilyOrEgg ? 'redball' : 'egg';
            }
            if (ft === 'ugg') {
                enemyInits.push({ type: 'ugg', row: ROWS-1, col: ROWS-1, jumping: false, jumpT: 0,
                    jumpDur: ENEMY_JUMP_DUR * gs.sm, moveTimer: 0,
                    moveInterval: enemyMoveInterval('ugg', gs.sm), hops: 0, falling: false,
                    willHatch: false, spawnAnimTimer: e.timer + 20, destRow: null, destCol: null, dirBits: null });
            } else if (ft === 'wrongway') {
                enemyInits.push({ type: 'wrongway', row: ROWS-1, col: 0, jumping: false, jumpT: 0,
                    jumpDur: ENEMY_JUMP_DUR * gs.sm, moveTimer: 0,
                    moveInterval: enemyMoveInterval('wrongway', gs.sm), hops: 0, falling: false,
                    willHatch: false, spawnAnimTimer: e.timer + 20, destRow: null, destCol: null, dirBits: null });
            } else {
                // egg/redball: spawns at col 0 or col 1 — add both as separate enemies
                for (var sc = 0; sc < 2; sc++) {
                    enemyInits.push({ type: ft, row: 1, col: sc, jumping: false, jumpT: 0,
                        jumpDur: ENEMY_JUMP_DUR * gs.sm, moveTimer: 0,
                        moveInterval: enemyMoveInterval(ft, gs.sm), hops: 0, falling: false,
                        willHatch: false, spawnAnimTimer: e.timer + 20, destRow: null, destCol: null, dirBits: null });
                }
            }
            continue;
        }
        enemyInits.push({ type: e.type, row: e.row, col: e.col,
            jumping: !!e.jumping, jumpT: e.jumpT || 0,
            jumpDur: e.jumpDur || ENEMY_JUMP_DUR * gs.sm,
            moveTimer: e.moveTimer || 0,
            moveInterval: e.moveInterval || enemyMoveInterval(e.type, gs.sm),
            hops: e.hops || 0, falling: !!e.falling, willHatch: !!e.willHatch,
            spawnAnimTimer: e.spawnAnimTimer || 0,
            destRow: e.destRow != null ? e.destRow : null,
            destCol: e.destCol != null ? e.destCol : null,
            dirBits: e.dirBits != null ? e.dirBits : null });
    }

    // Prune enemies too far to matter — Manhattan distance > DEPTH means it can't reach
    var pRow = gs.player.row, pCol = gs.player.col;
    var pruned = [];
    for (var pi = 0; pi < enemyInits.length; pi++) {
        var pe = enemyInits[pi];
        var eR = pe.jumping && pe.destRow != null ? pe.destRow : pe.row;
        var eC = pe.jumping && pe.destCol != null ? pe.destCol : pe.col;
        var dist = Math.abs(eR - pRow) + Math.abs(eC - pCol);
        if (dist <= DEPTH + 3) pruned.push(pe);
    }
    enemyInits = pruned;

    // Adaptive depth: reduce when many enemies to avoid timeouts
    if (enemyInits.length >= 6) DEPTH = Math.min(DEPTH, 4);
    else if (enemyInits.length >= 5) DEPTH = Math.min(DEPTH, 5);
    else if (enemyInits.length >= 4) DEPTH = Math.min(DEPTH, 6);

    // ── Per-path enemy paths: exact survival via tree search ───────────────────
    // Each enemy produces a list of {prob, tiles} paths. Survival correctly
    // handles path correlations across frames.
    var _dangerSurv = {};
    if (hasEnemies) {
        if (typeof window !== 'undefined' && window.AI_TEACHER && typeof perfectTeacherEval === 'function') {
            // Realtime perfect teacher: simStep-based expectimax, no danger tables.
            var _tT0 = typeof performance !== 'undefined' ? performance.now() : 0;
            perfectTeacherReset();
            // Adaptive deadline: higher levels need more time (enemies faster,
            // deeper search needed). Headless mode gets generous budget.
            var _teacherDeadline = window.AI_TEACHER_DEADLINE_MS ||
                (window._headlessTest ? 500 : Math.round(50 + Math.max(0, gs.sm - 1.4) * 200));
            _dangerSurv = perfectTeacherEval(gs, DEPTH, {
                mcSamples: window.AI_TEACHER_MC || 128,
                deadlineMs: _teacherDeadline
            });
            var _tT1 = typeof performance !== 'undefined' ? performance.now() : 0;
            if (!window._teacherTimings) window._teacherTimings = [];
            var _tStats = perfectTeacherStats();
            window._teacherTimings.push({
                ms: _tT1 - _tT0,
                depth: DEPTH,
                reachedDepth: _tStats.maxDepthSeen,
                nEnemies: enemyInits.length,
                hasSpawnTimer: (function() {
                    for (var _si = 0; _si < gs.enemies.length; _si++)
                        if (gs.enemies[_si].type === 'spawn-timer') return true;
                    return false;
                })()
            });
        } else {
            var _dtMaxFrames = DANGER_MAX_FRAMES;
            var _dtStartFrame = Math.min(gs.freezeTimer || 0, _dtMaxFrames);
            var _pathLists = [];
            for (var _di = 0; _di < enemyInits.length; _di++) {
                _pathLists.push(buildEnemyPaths(enemyInits[_di], gs.sm, _dtMaxFrames));
            }
            _dangerSurv = findReactiveSurvival(gs, _pathLists, coilyInit, _dtStartFrame, _dtMaxFrames, DEPTH);
        }
    }

    // ── Expectimax search using simStepForced ──────────────────────────────────
    // Replaces the hand-written survival tree with actual game engine simulation.
    // P(survive) = average over enemy choice combos of max over player directions.

    var _allZeros = [0,0,0,0,0,0,0,0];
    var _allOnes = [1,1,1,1,1,1,1,1];

    // Save/restore game state for undo-based expectimax.
    // Zero-allocation save: enemy fields saved into snapshot arrays.
    function saveGS(gs) {
        var p = gs.player, ne = gs.enemies.length;
        var es = gs.enemies.slice(); // shallow copy (array may be spliced)
        var eSnap = new Array(ne);
        for (var i = 0; i < ne; i++) {
            var e = es[i];
            eSnap[i] = e.type === 'spawn-timer'
                ? [e.type, e.timer, e.forcedType]
                : [e.type, e.row, e.col, e.jumping, e.jumpT, e.jumpDur,
                   e.destRow, e.destCol, e.jumpSrcRow, e.jumpSrcCol,
                   e.moveTimer, e.moveInterval, e.falling, e.willHatch,
                   e.hops, e.spawnAnimTimer, e.dirBits, e.lureRow, e.lureCol];
        }
        var dSnap = new Array(gs.discs.length);
        for (var i = 0; i < gs.discs.length; i++) dSnap[i] = gs.discs[i].active;
        return [p.row, p.col, p.prevRow, p.prevCol, p.jumping, p.jumpT,
                p.destRow, p.destCol, p.jumpSrcRow, p.jumpSrcCol, p.dead, p.deathTimer,
                gs.alive, gs.freezeTimer, gs.score, gs.levelWon, gs.cubesColored,
                es, eSnap, dSnap];
    }

    function restoreGS(gs, sn) {
        var p = gs.player;
        p.row=sn[0]; p.col=sn[1]; p.prevRow=sn[2]; p.prevCol=sn[3];
        p.jumping=sn[4]; p.jumpT=sn[5]; p.destRow=sn[6]; p.destCol=sn[7];
        p.jumpSrcRow=sn[8]; p.jumpSrcCol=sn[9]; p.dead=sn[10]; p.deathTimer=sn[11];
        gs.alive=sn[12]; gs.freezeTimer=sn[13]; gs.score=sn[14];
        gs.levelWon=sn[15]; gs.cubesColored=sn[16];
        gs.enemies = sn[17];
        var eSnap = sn[18], dSnap = sn[19];
        for (var i = 0; i < dSnap.length; i++) gs.discs[i].active = dSnap[i];
        for (var i = 0; i < eSnap.length; i++) {
            var e = gs.enemies[i], s = eSnap[i];
            if (s[0] === 'spawn-timer') { e.timer=s[1]; e.forcedType=s[2]; continue; }
            e.type=s[0]; e.row=s[1]; e.col=s[2]; e.jumping=s[3]; e.jumpT=s[4];
            e.jumpDur=s[5]; e.destRow=s[6]; e.destCol=s[7];
            e.jumpSrcRow=s[8]; e.jumpSrcCol=s[9]; e.moveTimer=s[10]; e.moveInterval=s[11];
            e.falling=s[12]; e.willHatch=s[13]; e.hops=s[14];
            e.spawnAnimTimer=s[15]; e.dirBits=s[16]; e.lureRow=s[17]; e.lureCol=s[18];
        }
    }

    function expectimax(gs, depth) {
        if (depth <= 0 || gs.levelWon) return 1.0;
        if (!gs.alive) return 0.0;
        if (typeof performance !== 'undefined' && performance.now() > _dirDeadline) return 1.0;

        var fullEnum = (depth >= DEPTH - 2);
        var N = fullEnum ? Math.min(countRandomDeciders(gs), 4) : 0;
        var combos = fullEnum ? (1 << N) : 2;
        var bestProb = 0;

        for (var dk = 0; dk < DIR_KEYS_WITH_STAY.length; dk++) {
            var dir = DIR_KEYS_WITH_STAY[dk];
            if (!simCanMove(gs, dir)) continue;

            var prob = 0;
            for (var combo = 0; combo < combos; combo++) {
                var choices;
                if (fullEnum) {
                    choices = [];
                    for (var b = 0; b < N; b++) choices.push((combo >> b) & 1);
                } else {
                    choices = combo === 0 ? _allZeros : _allOnes;
                }
                var snap = saveGS(gs);
                simStepForced(gs, dir, choices);
                if (gs.alive) {
                    prob += expectimax(gs, depth - 1) / combos;
                }
                restoreGS(gs, snap);
            }
            if (prob > bestProb) bestProb = prob;
        }
        return bestProb;
    }

    // Top-level: P(survive depth hops | forced first direction)
    function expectimaxDir(gs, dir, depth) {
        if (!simCanMove(gs, dir)) return 0;
        var N = countRandomDeciders(gs);
        var combos = 1 << Math.min(N, 4);
        var prob = 0;
        for (var combo = 0; combo < combos; combo++) {
            var choices = [];
            for (var b = 0; b < N; b++) choices.push((combo >> b) & 1);
            var snap = saveGS(gs);
            simStepForced(gs, dir, choices);
            if (gs.alive) {
                prob += expectimax(gs, depth - 1) / combos;
            }
            restoreGS(gs, snap);
        }
        return prob;
    }

    // ── Disc lure: when Coily is active, find nearest disc for luring ──
    // If player moves toward a disc and takes it with Coily nearby, Coily dies
    // and we get a long peaceful window. Reduce tour cost for disc-approaching dirs.
    var lureDisc = null, lureDiscAdj = null, lureDiscDist = 999;
    if (coilyInit && coilyInit.row >= 0) {
        for (var ldi = 0; ldi < gs.discs.length; ldi++) {
            var ld = gs.discs[ldi];
            if (!ld.active) continue;
            var laR = ld.row, laC = ld.side === 0 ? 0 : ld.row;
            var ldist = exBfsDist(gs.player.row, gs.player.col, laR, laC);
            if (ldist < lureDiscDist) {
                lureDiscDist = ldist;
                lureDisc = ld;
                lureDiscAdj = { row: laR, col: laC };
            }
        }
        // Only lure on toggle levels (L3+) where peaceful windows are critical,
        // and only if disc is reasonably reachable and Coily is close enough to follow
        var coilyPlayerDist = exBfsDist(coilyInit.row, coilyInit.col, gs.player.row, gs.player.col);
        if (gs.lv < 3 || lureDiscDist > 7 || coilyPlayerDist > 10) lureDisc = null;
    }

    // ── Core: survival tree safety check + strategy-aware tour cost per direction ──

    var safe1 = {};
    var safe2 = {};
    var tourCosts = {};
    var hop1Surv = {};

    var _loopT0 = typeof performance !== 'undefined' ? performance.now() : 0;
    for (var k = 0; k < DIR_KEYS_WITH_STAY.length; k++) {
        var dir = DIR_KEYS_WITH_STAY[k];
        if (!simCanMove(gs, dir)) continue;
        // Per-direction deadline: each direction gets fair share of remaining time
        var _perDirMs = window._headlessTest ? 80 : 30;
        _dirDeadline = typeof performance !== 'undefined' ? performance.now() + _perDirMs : Infinity;

        // Don't waste discs when there's no Coily
        if (!coilyActive && dir !== 'STAY') {
            var dd = DIRS[dir];
            var dnr = gs.player.row + dd.dr, dnc = gs.player.col + dd.dc;
            if (!isValidPos(dnr, dnc)) continue;
        }

        // L5+ disc parity check
        if (gs.lv >= 5 && dir !== 'STAY') {
            var dpd = DIRS[dir];
            var dpnr = gs.player.row + dpd.dr, dpnc = gs.player.col + dpd.dc;
            if (!isValidPos(dpnr, dpnc)) {
                var dpDiscRow = -1;
                for (var dpi = 0; dpi < gs.discs.length; dpi++) {
                    var dpc = gs.discs[dpi];
                    if (!dpc.active) continue;
                    if ((dpc.side === 0 && dir === 'UL' && gs.player.col === 0 && gs.player.row === dpc.row) ||
                        (dpc.side === 1 && dir === 'UR' && gs.player.col === gs.player.row && gs.player.row === dpc.row))
                        dpDiscRow = dpc.row;
                }
                if (dpDiscRow >= 0 && dpDiscRow % 2 === 0) {
                    var dcW = 0, dcB = 0;
                    for (var dci3 = 0; dci3 < gs.cubes.length; dci3++) {
                        var dcDef = (gs.tgt - gs.cubes[dci3].state + 3) % 3;
                        if (gs.cubes[dci3].row % 2 === 0) dcW += dcDef; else dcB += dcDef;
                    }
                    dcW = ((dcW - 1) % 3 + 3) % 3;
                    if (((dcW - dcB) % 3 + 3) % 3 === 1) continue;
                }
            }
        }

        // Level-completing move: if this direction lands on a cube whose stomp
        // finishes the level, survival after landing is irrelevant.
        var isLevelComplete = false;
        if (dir !== 'STAY') {
            var lcd = DIRS[dir];
            var lcr = gs.player.row + lcd.dr, lcc = gs.player.col + lcd.dc;
            if (isValidPos(lcr, lcc)) {
                var lcStompsAfter = 0;
                for (var lci = 0; lci < gs.cubes.length; lci++) {
                    var lcc2 = gs.cubes[lci];
                    var sn = stompsNeeded(lcc2.state, gs.lv);
                    if (lcc2.row === lcr && lcc2.col === lcc) sn = Math.max(0, sn - 1); // this cube gets stomped
                    lcStompsAfter += sn;
                }
                if (lcStompsAfter === 0) isLevelComplete = true;
            }
        }

        // Survival probability from precomputed danger tables (fast O(frames) lookup).
        var survProb = 1.0;
        if (hasEnemies) {
            survProb = _dangerSurv[dir] != null ? _dangerSurv[dir] : 0;
            // Level-complete: danger beyond this hop doesn't matter (level resets),
            // but we still need to survive the CURRENT hop. If teacher says P>0,
            // immediate landing is safe, override to 1.0.
            if (isLevelComplete && survProb > 0) {
                survProb = 1.0;
            } else if (!isLevelComplete) { // fall-through to swap check below

            // Cross-path (swap) collision check: if an enemy is about to jump
            // FROM the player's destination TO the player's source, they swap
            // mid-jump and both die (ROM $BD1E). Not captured by danger tables.
            if (survProb > 0 && dir !== 'STAY') {
                var _sd = DIRS[dir];
                var _pDestR = gs.player.row + _sd.dr, _pDestC = gs.player.col + _sd.dc;
                for (var _si = 0; _si < gs.enemies.length; _si++) {
                    var _se = gs.enemies[_si];
                    if (_se.type === 'spawn-timer' || _se.spawnAnimTimer > 0) continue;
                    // Enemy already jumping in swap direction
                    if (_se.jumping && _se.destRow === gs.player.row && _se.destCol === gs.player.col &&
                        _se.row === _pDestR && _se.col === _pDestC) {
                        survProb = 0; break;
                    }
                    // Enemy at player's dest, about to move (moveTimer near full)
                    if (!_se.jumping && _se.row === _pDestR && _se.col === _pDestC &&
                        _se.moveTimer + 1 >= _se.moveInterval) {
                        // Might move to player's source — check if possible move includes it
                        var _choices = getMoveChoicesForType(_se.type, _se.row, _se.col);
                        for (var _ci = 0; _ci < _choices.length; _ci++) {
                            if (_choices[_ci][0] === gs.player.row && _choices[_ci][1] === gs.player.col) {
                                // Possible swap — conservatively mark unsafe
                                survProb = 0; break;
                            }
                        }
                        if (survProb === 0) break;
                    }
                }
            }
            } // end else if (!isLevelComplete)
        }
        hop1Surv[dir] = survProb;


        // Compute tour cost — if simStep dies on this RNG seed, use current state estimate
        var _tcT0 = typeof performance !== 'undefined' ? performance.now() : 0;
        simSeed(k * 100);
        var tcClone = simDeepClone(gs);
        var tcAlive = simStep(tcClone, dir);
        var tc;
        if (tcAlive) {
            tc = tcClone.levelWon ? 0 : simTourCost(tcClone);
            // Level-completing move: override survival to 1.0 — no need to survive
            // 8 more hops when the level ends on landing
            if (tcClone.levelWon) { survProb = 1.0; hop1Surv[dir] = 1.0; }
        } else {
            tc = simTourCost(gs) + 1; // simStep failed with this seed; approximate
        }
        // STAY penalty: escalates with consecutive STAYs, much higher during freeze
        // (freeze = enemies can't move, so STAY wastes the safe window)
        var stayPenalty = 5 + aiStayCount * 3;
        if (gs.freezeTimer > 0) stayPenalty += 20;
        if (dir === 'STAY') tc += stayPenalty;

        // Anti-oscillation: on toggle levels with excessive hops, penalize
        // directions that land on completed cubes (prevents undo/redo cycles)
        if (gs.lv >= 3 && dir !== 'STAY' && typeof hops !== 'undefined' && hops > 200) {
            var aod = DIRS[dir];
            var aor = gs.player.row + aod.dr, aoc = gs.player.col + aod.dc;
            if (isValidPos(aor, aoc)) {
                for (var aoi = 0; aoi < gs.cubes.length; aoi++) {
                    if (gs.cubes[aoi].row === aor && gs.cubes[aoi].col === aoc && gs.cubes[aoi].state >= gs.tgt) {
                        tc += 10 + Math.floor(hops / 100) * 5; // 15 at 200 hops, 20 at 300, etc.
                        break;
                    }
                }
            }
        }

        // Disc lure bonus: reduce tour cost for directions moving toward disc
        // Luring Coily = long peaceful window (~6 hops of safe progress)
        if (lureDisc && dir !== 'STAY') {
            var dd2 = DIRS[dir];
            var lnr = gs.player.row + dd2.dr, lnc = gs.player.col + dd2.dc;
            if (isValidPos(lnr, lnc) && lureDiscAdj) {
                var distBefore = exBfsDist(gs.player.row, gs.player.col, lureDiscAdj.row, lureDiscAdj.col);
                var distAfter = exBfsDist(lnr, lnc, lureDiscAdj.row, lureDiscAdj.col);
                if (distAfter < distBefore) {
                    var coilyDist = exBfsDist(coilyInit.row, coilyInit.col, gs.player.row, gs.player.col);
                    var lureBonus = coilyDist <= 3 ? 15 : (coilyDist <= 5 ? 10 : 5);
                    tc -= lureBonus;
                }
            } else if (!isValidPos(lnr, lnc)) {
                // Disc-jump direction: if this rides a disc with Coily active, big bonus
                // (simStep handles the ride, but tc doesn't reflect the peaceful window)
                for (var dji = 0; dji < gs.discs.length; dji++) {
                    var djd = gs.discs[dji];
                    if (!djd.active) continue;
                    if ((djd.side === 0 && dir === 'UL' && gs.player.col === 0 && gs.player.row === djd.row) ||
                        (djd.side === 1 && dir === 'UR' && gs.player.col === gs.player.row && gs.player.row === djd.row)) {
                        tc -= 15;
                        break;
                    }
                }
            }
        }


        tourCosts[dir] = tc;
        var _tcMs = typeof performance !== 'undefined' ? performance.now() - _tcT0 : 0;
        if (_tcMs > 30) console.log('TC SLOW: ' + _tcMs.toFixed(0) + 'ms dir=' + dir);

        // Combined score: P(survive)^SAFETY_EXP × discount^tour_cost
        // SAFETY_EXP < 1 compresses probabilities toward 1 (less risk-averse)
        // DISCOUNT < 1 penalizes longer tours (each extra hop = more danger)
        // PROB_FLOOR: minimum probability to consider (below = give up)
        // Score = log(P_per_hop) - λ × tour_cost
        // log(P_per_hop) = log(P_D) / D normalizes danger across depths.
        // λ controls how much tour progress matters vs survival.
        var LAMBDA = window.AI_LAMBDA || 0.002;
        var logPerHop = survProb > 0 ? Math.log(survProb) / DEPTH : -100;
        var score = logPerHop - LAMBDA * tc;
        if (survProb <= 0) {
            aiMoveScores[dir] = -10000;
            continue;
        }
        safe1[dir] = true;
        safe2[dir] = true;
        aiMoveScores[dir] = Math.round(score * 10000);
    }

    // Safety-first: if any direction has P=1.0, never gamble on P<1.0.
    // At corner positions (≤2 valid exits), exclude STAY from triggering this rule —
    // STAY=1.0 at corners leads to horizon traps where enemies converge beyond lookahead.
    var validExits = 0;
    for (var vk = 0; vk < DIR_KEYS.length; vk++) {
        var vd = DIRS[DIR_KEYS[vk]];
        if (isValidPos(gs.player.row + vd.dr, gs.player.col + vd.dc)) validExits++;
    }
    var isCorner = (validExits <= 2);
    var hasPerfect = false;
    for (var sk in hop1Surv) {
        if (isCorner && sk === 'STAY') continue;
        if (hop1Surv[sk] >= 1.0 && aiMoveScores[sk] !== undefined) { hasPerfect = true; break; }
    }
    if (hasPerfect) {
        for (var sk2 in hop1Surv) {
            if (hop1Surv[sk2] < 1.0 && aiMoveScores[sk2] !== undefined && aiMoveScores[sk2] > -10000) {
                aiMoveScores[sk2] = -10000;
            }
        }
    }

    aiLastHop1Surv = hop1Surv;
    aiLastTourCosts = tourCosts;
    aiLureTarget = lureDiscAdj; // export for viz

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
                    if (safe1[DIR_KEYS[sk]] && safe2[DIR_KEYS[sk]] && aiMoveScores[DIR_KEYS[sk]] > -10000) {
                        restoreRng(); return DIR_KEYS[sk];
                    }
                }
            }
        }
    }

    // Pick direction with best combined score (survival prob × tour value)
    var bestDir = null, bestScore = -Infinity;
    for (var fk = 0; fk < DIR_KEYS_WITH_STAY.length; fk++) {
        var fd = DIR_KEYS_WITH_STAY[fk];
        if (aiMoveScores[fd] === undefined) continue;
        if (aiMoveScores[fd] > bestScore) { bestScore = aiMoveScores[fd]; bestDir = fd; }
    }
    restoreRng();
    var _perfMs = typeof performance !== 'undefined' ? performance.now() - _perfStart : 0;
    if (_perfMs > 100) {
        var _teacherMs = window._teacherTimings && window._teacherTimings.length > 0 ? window._teacherTimings[window._teacherTimings.length-1].ms : 0;
        var _loopMs = typeof performance !== 'undefined' ? performance.now() - _loopT0 : 0;
        var _preLoopMs = _loopT0 - _perfStart;
        console.log('AI SLOW: ' + _perfMs.toFixed(0) + 'ms (teacher=' + _teacherMs.toFixed(0) + 'ms pre=' + _preLoopMs.toFixed(0) + 'ms loop=' + _loopMs.toFixed(0) + 'ms), enemies=' + enemyInits.length + ' pos=(' + gs.player.row + ',' + gs.player.col + ') dir=' + (bestDir||'?'));
    }

    return bestDir || 'STAY';
}

// ─── Main entry point ────────────────────────────────────────────────────────
var aiMoveScores = {};  // exported per-direction scores for viz
var aiLastTourCosts = {};  // last per-direction tour costs from unifiedPick
var aiLastHop1Surv = {};   // last hop-1 survival rates from unifiedPick
var aiLureTarget = null;   // disc-adjacent position being targeted for lure {row,col}
var aiMode = 0;         // 0 = no AI, 1 = unified (always set to 1 now)
var aiStayCount = 0;    // consecutive STAY decisions — used to break stuck loops
var aiLastPos = '';     // last position key — used to detect oscillation
var aiSamePosCount = 0; // frames spent on same tile
var aiLastRemaining = 99; // cubes remaining last time we checked
var aiBestRemaining = 99; // historical best (lowest) remaining — only reset on new best
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
    // When enemies are disabled via UI, clear them so AI ignores them
    if (typeof enemiesEnabled !== 'undefined' && !enemiesEnabled) {
        gs.enemies = [];
        coilyActive = false;
    }
    aiMoveScores = {};
    aiMode = 1;

    // Track how long we've been on the same tile
    var posKey = gs.player.row + ',' + gs.player.col;
    if (posKey === aiLastPos) aiSamePosCount++;
    else { aiSamePosCount = 0; aiLastPos = posKey; }

    // Track last visit time for each cube (for oscillation-aware tour planning)
    var curIdx = posToIdx[gs.player.row * ROWS + gs.player.col];
    if (curIdx >= 0) aiCubeLastVisit[curIdx] = typeof hops !== 'undefined' ? hops : 0;

    // Track progress: count remaining cubes
    var tgt = gs.tgt;
    var curRemaining = 0;
    for (var ci = 0; ci < gs.cubes.length; ci++)
        if (gs.cubes[ci].state < tgt) curRemaining++;
    aiLastRemaining = curRemaining;
    if (curRemaining < aiBestRemaining) {
        // Real progress — new historical best
        aiBestRemaining = curRemaining;
        aiNoProgressCount = 0;
    } else if (gs.lv >= 3 && curRemaining > aiBestRemaining) {
        // Toggle level: remaining went UP past best — count faster
        aiNoProgressCount += 2;
    } else {
        aiNoProgressCount++;
    }

    // Track cube reverts on toggle levels — detect which cubes keep getting churned
    if (gs.lv >= 3 && aiPrevCubeStates) {
        for (var ri = 0; ri < gs.cubes.length; ri++) {
            var cube = gs.cubes[ri];
            if (aiPrevCubeStates[ri] >= tgt && cube.state < tgt) {
                // This cube was completed but got reverted
                var ridx = posToIdx[cube.row * ROWS + cube.col];
                if (ridx >= 0) aiRevertCounts[ridx] = Math.min(aiRevertCounts[ridx] + 1, 10);
            }
        }
    }
    // Save current states for next comparison
    aiPrevCubeStates = new Int8Array(gs.cubes.length);
    for (var si = 0; si < gs.cubes.length; si++) aiPrevCubeStates[si] = gs.cubes[si].state;

    var result = unifiedPick(gs, coilyActive);
    var _origResult = result;

    // Validate: if danger table predicts P=1.0, run simStep to verify
    if (window._predValidate && result && result !== 'STAY' && aiLastHop1Surv && aiLastHop1Surv[result] !== undefined) {
        var _predP = aiLastHop1Surv[result];
        if (_predP >= 0.99) {
            var _savedRng = simRng;
            var _savedQ = simHopDecisionQ, _savedIdx = simHopDecisionIdx;
            simHopDecisionQ = null; // use simRng fallback
            for (var _sd = 0; _sd < 4; _sd++) {
                var _vgs = simDeepClone(gs);
                _vgs.survivalOnly = true;
                simRng = createSeededRng(_sd * 1000 + 7);
                if (!simStep(_vgs, result)) {
                    // Pre-death state for debugging
                    var _preStr = '';
                    var _preGs = simDeepClone(gs);
                    for (var _pi = 0; _pi < _preGs.enemies.length; _pi++) {
                        var _pe = _preGs.enemies[_pi];
                        if (_pe.type === 'spawn-timer') continue;
                        _preStr += ' ' + _pe.type + '@(' + _pe.row + ',' + _pe.col + ')';
                        if (_pe.jumping) _preStr += '→(' + _pe.destRow + ',' + _pe.destCol + ')j' + (_pe.jumpT||0).toFixed(2);
                        _preStr += 'mt' + (_pe.moveTimer||0) + '/' + (_pe.moveInterval||0);
                    }
                    var _playStr = 'player@(' + gs.player.row + ',' + gs.player.col + ')';
                    if (gs.player.jumping) _playStr += 'j' + (gs.player.jumpT||0).toFixed(2) + '→(' + gs.player.destRow + ',' + gs.player.destCol + ')';
                    _playStr += ' prev=(' + gs.player.prevRow + ',' + gs.player.prevCol + ')';
                    _playStr += ' ft=' + (gs.freezeTimer||0);
                    // spawn-timers
                    var _stStr = '';
                    for (var _stI = 0; _stI < gs.enemies.length; _stI++) {
                        if (gs.enemies[_stI].type === 'spawn-timer') _stStr += ' st:' + gs.enemies[_stI].timer + ':' + (gs.enemies[_stI].forcedType||'?');
                    }
                    console.log('PRE-STATE ' + _playStr + ' ' + _preStr + _stStr);
                    // Dump full state snapshot for offline repro
                    var _snap = { player: JSON.parse(JSON.stringify(gs.player)),
                                  enemies: JSON.parse(JSON.stringify(gs.enemies)),
                                  sm: gs.sm, tgt: gs.tgt, lv: gs.lv, round: gs.round,
                                  freezeTimer: gs.freezeTimer, dir: result,
                                  teacherP: aiLastHop1Surv[result] };
                    console.log('SNAPSHOT ' + JSON.stringify(_snap));
                    // Died — report details
                    var _killer = _vgs.deathEnemy || '?';
                    // Find the enemy that killed — search for one at player pos
                    var _killerPos = '';
                    for (var _vi = 0; _vi < _vgs.enemies.length; _vi++) {
                        var _ve = _vgs.enemies[_vi];
                        if (_ve.type === _killer) {
                            _killerPos = '@(' + _ve.row + ',' + _ve.col + ')';
                            if (_ve.jumping) _killerPos += 'j' + (_ve.jumpT||0).toFixed(2);
                            break;
                        }
                    }
                    var _pPos = '(' + _vgs.player.row + ',' + _vgs.player.col + ')';
                    if (_vgs.player.jumping) _pPos += 'j' + (_vgs.player.jumpT||0).toFixed(2);
                    console.log('PRED-FAIL @(' + gs.player.row + ',' + gs.player.col + ') dir=' + result +
                        ' seed=' + _sd + ' killer=' + _killer + _killerPos + ' player=' + _pPos);
                    break;
                }
            }
            simRng = _savedRng;
            simHopDecisionQ = _savedQ; simHopDecisionIdx = _savedIdx;
        }
    }

    // Doomed-state detection: if current state has all dirs P=0, the AI was
    // led into an inescapable trap. Log the PREVIOUS state that committed to
    // it (and the teacher's P at the time) for diagnosis.
    if (typeof window !== 'undefined' && window._predValidate && aiLastHop1Surv) {
        var _allZero = true, _anyEval = false;
        for (var _dkk in aiLastHop1Surv) {
            _anyEval = true;
            if (aiLastHop1Surv[_dkk] > 0) { _allZero = false; break; }
        }
        if (_allZero && _anyEval && window._preDoomSnap) {
            console.log('DOOM @(' + gs.player.row + ',' + gs.player.col +
                ') prev-dir=' + window._preDoomSnap.dir +
                ' prev-survP=' + JSON.stringify(window._preDoomSnap.survP));
        }
        // Save lightweight pre-doom info
        window._preDoomSnap = {
            dir: result, survP: JSON.parse(JSON.stringify(aiLastHop1Surv))
        };
    }

    // Record decision history for death diagnosis
    if (!window._aiDecisionLog) window._aiDecisionLog = [];
    var enemySnap = '';
    for (var dli = 0; dli < gs.enemies.length; dli++) {
        var dle = gs.enemies[dli];
        if (dle.type === 'spawn-timer') continue;
        enemySnap += ' ' + dle.type + '@(' + dle.row + ',' + dle.col + ')';
        if (dle.spawnAnimTimer > 0) enemySnap += 'sa' + dle.spawnAnimTimer;
        else if (dle.jumping) enemySnap += 'j' + (dle.jumpT||0).toFixed(2) + '→(' + dle.destRow + ',' + dle.destCol + ')';
        else enemySnap += 't' + (dle.moveTimer||0);
    }
    var probSnap = '';
    for (var dlk in aiLastHop1Surv) probSnap += ' ' + dlk + '=' + (aiLastHop1Surv[dlk] !== undefined ? aiLastHop1Surv[dlk].toFixed(3) : '?');
    window._aiDecisionLog.push({
        hop: typeof hops !== 'undefined' ? hops : 0,
        pos: '(' + gs.player.row + ',' + gs.player.col + ')',
        dir: result,
        probs: probSnap.trim(),
        enemies: enemySnap.trim(),
        scores: JSON.parse(JSON.stringify(aiMoveScores))
    });
    if (window._aiDecisionLog.length > 80) window._aiDecisionLog.shift();

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
                    // Only accept moves that haven't been demoted (not blocked or gamble)
                    if (asc !== undefined && asc <= -10000) continue;
                    // At level 3+: avoid alternatives that revert completed cubes
                    if (completedCubes[aKey]) continue;
                    if (asc !== undefined && asc > altScore) { altScore = asc; altDir = DIR_KEYS[ak]; }
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
                        if (asc2 !== undefined && asc2 <= -10000) continue;
                        if (asc2 !== undefined && asc2 > altScore) { altScore = asc2; altDir = DIR_KEYS[ak2]; }
                    }
                }
                // Safety guard: don't override if the alternative is substantially
                // less safe than the original. logPerHop difference > 0.02 means
                // per-hop survival drops by >~2% — not worth it to break oscillation.
                if (altDir) {
                    var origScore = aiMoveScores[result];
                    if (origScore !== undefined && origScore > altScore + 200) {
                        altDir = null;
                    }
                }
                if (altDir) { result = altDir; aiPosHistory.length = 0; }
            }
        }
    }

    // Hard stuck breaker: at 500+ hops on toggle levels, directly target nearest
    // unfinished cube regardless of safety — oscillation is worse than a death.
    if (gs.lv >= 3 && typeof hops !== 'undefined' && hops > 500 && result !== 'STAY') {
        var nearestUnf = null, nearestUnfDist = 999;
        for (var nui = 0; nui < gs.cubes.length; nui++) {
            if (gs.cubes[nui].state < gs.tgt) {
                var nud = exBfsDist(gs.player.row, gs.player.col, gs.cubes[nui].row, gs.cubes[nui].col);
                if (nud < nearestUnfDist) { nearestUnfDist = nud; nearestUnf = gs.cubes[nui]; }
            }
        }
        if (nearestUnf) {
            var bfs = bfsTo(gs.player.row, gs.player.col, nearestUnf.row, nearestUnf.col);
            if (bfs && bfs.path.length > 0 && simCanMove(gs, bfs.path[0])) {
                // Only override if the direction isn't fatal
                var bfsScore = aiMoveScores[bfs.path[0]];
                if (bfsScore !== undefined && bfsScore > -10000) result = bfs.path[0];
            }
        }
    }

    // L5+ parity fix: compute (W-B) mod 3 from actual cube states.
    // Unsolvable when (W-B) ≡ 1 mod 3 from even row, or ≡ 2 from odd row.
    // If stuck in bad parity, jump off an odd row to shift it.
    if (gs.lv >= 5 && aiNoProgressCount > 50) {
        var parW = 0, parB = 0;
        for (var pi = 0; pi < gs.cubes.length; pi++) {
            var pdef = (gs.tgt - gs.cubes[pi].state + 3) % 3;
            if (gs.cubes[pi].row % 2 === 0) parW += pdef; else parB += pdef;
        }
        var parGap = ((parW - parB) % 3 + 3) % 3;
        var playerEven = gs.player.row % 2 === 0;
        var parBad = (playerEven && parGap === 1) || (!playerEven && parGap === 2);
        if (parBad && gs.player.row % 2 === 1) {
            // On odd row with bad parity — jump off edge to fix
            for (var fk = 0; fk < DIR_KEYS.length; fk++) {
                var fd = DIRS[DIR_KEYS[fk]];
                var fnr = gs.player.row + fd.dr, fnc = gs.player.col + fd.dc;
                if (!isValidPos(fnr, fnc)) { result = DIR_KEYS[fk]; break; }
                // Also check discs — don't jump onto a disc
                var isDiscJump = false;
                for (var fdi = 0; fdi < gs.discs.length; fdi++) {
                    var fdc = gs.discs[fdi];
                    if (fdc.active && fdc.row === gs.player.row) isDiscJump = true;
                }
                if (!isDiscJump && !isValidPos(fnr, fnc)) { result = DIR_KEYS[fk]; break; }
            }
        } else if (parBad && playerEven) {
            // On even row — need to get to odd row first, then fall
            // Just let the normal AI move to an odd row; the fall will trigger next time
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
                        if (psc !== undefined && psc > -10000 && psc > bestProgScore) {
                            bestProgScore = psc; bestProgDir = DIR_KEYS[pk];
                        }
                        break;
                    }
                }
            }
            // Phase 2 (>20): pick best safe direction by tour cost
            if (!bestProgDir && aiNoProgressCount > 20) {
                var bestTC = Infinity;
                for (var pk2 = 0; pk2 < DIR_KEYS.length; pk2++) {
                    var pk2sc = aiMoveScores[DIR_KEYS[pk2]];
                    if (pk2sc !== undefined && pk2sc > -10000 && aiLastTourCosts[DIR_KEYS[pk2]] !== undefined) {
                        if (aiLastTourCosts[DIR_KEYS[pk2]] < bestTC) {
                            bestTC = aiLastTourCosts[DIR_KEYS[pk2]];
                            bestProgDir = DIR_KEYS[pk2];
                        }
                    }
                }
            }
            // Phase 3 (>30): pick any safe move
            if (!bestProgDir && aiNoProgressCount > 30) {
                if (gs.lv >= 5) {
                    // BFS avoiding completed cubes to find nearest unfinished
                    var avoidSet = {};
                    for (var avi2 = 0; avi2 < gs.cubes.length; avi2++)
                        if (gs.cubes[avi2].state >= gs.tgt)
                            avoidSet[gs.cubes[avi2].row + ',' + gs.cubes[avi2].col] = true;
                    // Try BFS with avoid set first, then without
                    for (var avoidPass = 0; avoidPass < 2 && !bestProgDir; avoidPass++) {
                        var useAvoid = (avoidPass === 0) ? avoidSet : null;
                        for (var pk3 = 0; pk3 < DIR_KEYS.length; pk3++) {
                            if (!simCanMove(gs, DIR_KEYS[pk3])) continue;
                            var pk3sc = aiMoveScores[DIR_KEYS[pk3]];
                            if (pk3sc === undefined || pk3sc <= -10000) continue;
                            var pk3d = DIRS[DIR_KEYS[pk3]];
                            var pk3r = gs.player.row + pk3d.dr, pk3c = gs.player.col + pk3d.dc;
                            if (!isValidPos(pk3r, pk3c)) continue;
                            // Check if this direction leads toward an unfinished cube
                            var pk3bfs = bfsTo(pk3r, pk3c, -1, -1, useAvoid);
                            // Find nearest unfinished via BFS
                            for (var uf3 = 0; uf3 < gs.cubes.length; uf3++) {
                                if (gs.cubes[uf3].state >= gs.tgt) continue;
                                var uf3path = bfsTo(pk3r, pk3c, gs.cubes[uf3].row, gs.cubes[uf3].col, useAvoid);
                                if (uf3path && (!bestProgDir || uf3path.dist < bestProgScore)) {
                                    bestProgScore = uf3path.dist; bestProgDir = DIR_KEYS[pk3];
                                }
                            }
                        }
                    }
                }
                if (!bestProgDir) {
                    for (var pk3b = 0; pk3b < DIR_KEYS.length; pk3b++) {
                        if (!simCanMove(gs, DIR_KEYS[pk3b])) continue;
                        var pk3bsc = aiMoveScores[DIR_KEYS[pk3b]];
                        if (pk3bsc !== undefined && pk3bsc >= 0) {
                            bestProgDir = DIR_KEYS[pk3b]; break;
                        }
                    }
                }
            }
            // Safety guard: don't override if progress move is much less safe
            if (bestProgDir) {
                var origScoreN = aiMoveScores[result];
                var progScoreN = aiMoveScores[bestProgDir];
                if (origScoreN !== undefined && progScoreN !== undefined && origScoreN > progScoreN + 200) {
                    bestProgDir = null;
                }
            }
            if (bestProgDir) { result = bestProgDir; aiPosHistory.length = 0; }
            // Don't reset aiNoProgressCount here — only reset on actual progress (line ~961)
        }
    }

    // Break stuck STAY loops — only override with equally-safe alternatives
    if (result === 'STAY') {
        aiStayCount++;
        if (aiStayCount >= 3) {
            var stayP = aiLastHop1Surv['STAY'] || 0;
            var bestAlt = null, bestAltScore = -Infinity;
            for (var k = 0; k < DIR_KEYS.length; k++) {
                if (simCanMove(gs, DIR_KEYS[k])) {
                    var sc = aiMoveScores[DIR_KEYS[k]];
                    if (sc === undefined || sc <= -10000) continue;
                    var altP = aiLastHop1Surv[DIR_KEYS[k]] || 0;
                    if (altP < stayP) continue;
                    if (sc > bestAltScore) {
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
    if (_origResult !== result && typeof console !== 'undefined') {
        var _origS = aiMoveScores[_origResult], _newS = aiMoveScores[result];
        console.log('AI OVERRIDE @(' + gs.player.row + ',' + gs.player.col + ') orig=' + _origResult + '(' + _origS + ') new=' + result + '(' + _newS + ') np=' + aiNoProgressCount + ' stay=' + aiStayCount);
    }
    return result;
}
