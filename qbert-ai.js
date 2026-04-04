// qbert-ai.js — Q*bert AI logic (peel routing)
var AI_VERSION = 'v14.1-multiHopTable';
// Requires: qbert.js loaded first (provides constants, board, simulation)
//
// Provides: aiPickBestDir() — main entry point for AI move selection
//
// Algorithm: graph-peeling determines WHAT to complete next (outside-in),
// BFS determines HOW to get there, MC simulation validates IF it's safe.

// ─── Stomps helper ──────────────────────────────────────────────────────────

// How many stomps does a cube need to reach target state?
function stompsNeeded(cubeState, lv) {
    var tgt = (lv === 1 || lv === 3) ? 1 : 2;
    if (cubeState >= tgt) return 0;
    if (lv <= 2) return tgt - cubeState;
    if (lv === 3) return cubeState === 0 ? 1 : 0;
    if (lv === 4) return cubeState === 0 ? 2 : (cubeState === 1 ? 1 : 0);
    return cubeState === 0 ? 2 : (cubeState === 1 ? 1 : 0);
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
            if (dist < bestDist || (dist === bestDist && Math.random() < 0.5)) { bestDist = dist; bestDir = k; }
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
        if (dist < bestDist || (dist === bestDist && Math.random() < 0.5)) { bestDist = dist; bestDir = k; }
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
        if (e.type === 'slick' || e.type === 'sam' || e.type === 'greenball') continue;
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

// ─── Precomputed enemy danger tables (probabilistic) ────────────────────────
// For each enemy, precompute P(enemy at posIdx | frame) across all random choices.
// Non-Coily enemies have player-independent paths (binary random 50/50 per hop).
// P(survive all enemies) = product of per-enemy P(no collision).
// This replaces recursive enemyPathCollides with O(frames) table lookups.

// Max frames: 3 hops × ~35 frames/hop = ~105, plus buffer
var DANGER_MAX_FRAMES = 120;

// Accumulate probability at (frame, row, col) in the danger table.
// table is Float32Array[maxFrames * POS_COUNT].
function dangerAdd(table, frame, row, col, prob, maxFrames) {
    if (frame >= maxFrames) return;
    var idx = posToIdx[row * ROWS + col];
    if (idx >= 0) table[frame * POS_COUNT + idx] += prob;
}

// Recursively expand all possible enemy paths, accumulating probability.
// prob = probability of this specific path (halves at each binary branch).
function expandEnemyPaths(table, type, row, col, jumping, jumpT, jumpDur,
                          moveTimer, moveInterval, hops, falling, willHatch,
                          spawnDrop, destRow, destCol, idleTimer,
                          frame, maxFrames, sm, prob) {
    if (frame >= maxFrames) return;
    // Falling enemy: still at source tile during first 1/3 of jump
    if (falling) {
        if (jumping) {
            var newJT = jumpT + jumpDur;
            if (newJT < 0.33) {
                dangerAdd(table, frame, row, col, prob, maxFrames);
                expandEnemyPaths(table, type, row, col, true, newJT, jumpDur,
                    moveTimer, moveInterval, hops, true, willHatch,
                    0, destRow, destCol, idleTimer,
                    frame + 1, maxFrames, sm, prob);
            } else if (newJT < 0.67) {
                // mid-air immune, continue ticking
                expandEnemyPaths(table, type, row, col, true, newJT, jumpDur,
                    moveTimer, moveInterval, hops, true, willHatch,
                    0, destRow, destCol, idleTimer,
                    frame + 1, maxFrames, sm, prob);
            }
            // >= 0.67: at off-board dest, done
        }
        return;
    }

    // Spawn drop: enemy falling from sky, no collision
    if (spawnDrop > 0) {
        expandEnemyPaths(table, type, row, col, jumping, jumpT, jumpDur,
            moveTimer, moveInterval, hops, falling, willHatch,
            spawnDrop - 1, destRow, destCol, idleTimer,
            frame + 1, maxFrames, sm, prob);
        return;
    }

    // Jumping: advance jumpT
    if (jumping) {
        var newJumpT = jumpT + jumpDur;
        if (newJumpT >= 1) {
            // Landed
            var landRow = destRow, landCol = destCol;
            if (!isValidPos(landRow, landCol)) return; // fell off
            var newType = type, newInterval = moveInterval, newWillHatch = false;
            if (type === 'egg' && (hops >= 6 || landRow >= ROWS - 1 || willHatch)) {
                newType = 'coily';
                // Egg hatched into Coily — mark landing + extra frames conservatively
                // (Coily is player-dependent so we can't precompute further)
                dangerAdd(table, frame, landRow, landCol, prob, maxFrames);
                for (var ef = 1; ef <= 10; ef++)
                    dangerAdd(table, frame + ef, landRow, landCol, prob, maxFrames);
                return;
            }
            // Collision tile: last 1/3 of jump = dest
            dangerAdd(table, frame, landRow, landCol, prob, maxFrames);
            // Post-landing idle
            expandEnemyPaths(table, newType, landRow, landCol, false, 0, jumpDur,
                0, newInterval, hops, false, newWillHatch,
                0, null, null, ENEMY_IDLE_FRAMES,
                frame + 1, maxFrames, sm, prob);
        } else {
            // Mid-jump collision tile
            if (newJumpT < 0.33) {
                dangerAdd(table, frame, row, col, prob, maxFrames);
            } else if (newJumpT >= 0.67) {
                if (destRow != null) dangerAdd(table, frame, destRow, destCol, prob, maxFrames);
            }
            // else: mid-air immune
            expandEnemyPaths(table, type, row, col, true, newJumpT, jumpDur,
                moveTimer, moveInterval, hops, falling, willHatch,
                0, destRow, destCol, idleTimer,
                frame + 1, maxFrames, sm, prob);
        }
        return;
    }

    // Idle timer (post-landing pause)
    if (idleTimer > 0) {
        dangerAdd(table, frame, row, col, prob, maxFrames);
        expandEnemyPaths(table, type, row, col, false, 0, jumpDur,
            moveTimer, moveInterval, hops, false, willHatch,
            0, null, null, idleTimer - 1,
            frame + 1, maxFrames, sm, prob);
        return;
    }

    // Move timer tick
    var newMoveTimer = moveTimer + 1;
    if (newMoveTimer < moveInterval) {
        dangerAdd(table, frame, row, col, prob, maxFrames);
        expandEnemyPaths(table, type, row, col, false, 0, jumpDur,
            newMoveTimer, moveInterval, hops, false, willHatch,
            0, null, null, 0,
            frame + 1, maxFrames, sm, prob);
        return;
    }

    // Move! Branch on choices (50/50 each).
    var choices = getMoveChoicesForType(type, row, col);
    dangerAdd(table, frame, row, col, prob, maxFrames);
    var branchProb = choices.length > 0 ? prob / choices.length : prob;
    for (var ci = 0; ci < choices.length; ci++) {
        var nr = choices[ci][0], nc = choices[ci][1];
        var newFalling = !isValidPos(nr, nc);
        var newHops = hops + 1;
        var newWH = false;
        if (type === 'egg' && (newHops >= 6 || nr >= ROWS - 1)) newWH = true;
        expandEnemyPaths(table, type, row, col, true, 0, jumpDur,
            0, moveInterval, newHops, newFalling, newWH,
            0, nr, nc, 0,
            frame + 1, maxFrames, sm, branchProb);
    }
}

// Movement choices by type (player-independent)
function getMoveChoicesForType(type, row, col) {
    if (type === 'egg' || type === 'redball') {
        return [[row + 1, col], [row + 1, col + 1]];
    }
    if (type === 'ugg') {
        return [[row - 1, col - 1], [row, col - 1]];
    }
    if (type === 'wrongway') {
        return [[row - 1, col], [row, col + 1]];
    }
    return [];
}

// Build probabilistic danger table for a non-Coily enemy.
// Returns Float32Array[maxFrames * POS_COUNT] with P(enemy here at frame).
function buildEnemyDangerTable(e, sm, maxFrames) {
    var table = new Float32Array(maxFrames * POS_COUNT);
    var jumpDur = e.jumpDur || ENEMY_JUMP_DUR * sm;
    var interval = e.moveInterval || enemyMoveInterval(e.type, sm);
    expandEnemyPaths(table, e.type, e.row, e.col,
        !!e.jumping, e.jumpT || 0, jumpDur,
        e.moveTimer || 0, interval, e.hops || 0,
        !!e.falling, !!e.willHatch,
        e.spawnDrop || 0,
        e.destRow != null ? e.destRow : null,
        e.destCol != null ? e.destCol : null,
        e.idleTimer || 0,
        0, maxFrames, sm, 1.0);
    return table;
}

// Build danger table for Coily (deterministic — chases a fixed target).
// Returns Float32Array with P=1.0 at Coily's position each frame.
function buildCoilyDangerTable(e, targetR, targetC, sm, maxFrames) {
    var table = new Float32Array(maxFrames * POS_COUNT);
    var jumpDur = e.jumpDur || ENEMY_JUMP_DUR * sm;
    var interval = e.moveInterval || enemyMoveInterval('coily', sm);
    var row = e.row, col = e.col;
    var jumping = !!e.jumping, jumpT = e.jumpT || 0;
    var moveTimer = e.moveTimer || 0;
    var destRow = e.destRow, destCol = e.destCol;
    var idleTimer = e.idleTimer || 0;
    var spawnDrop = e.spawnDrop || 0;

    for (var f = 0; f < maxFrames; f++) {
        if (spawnDrop > 0) { spawnDrop--; continue; }

        if (jumping) {
            jumpT += jumpDur;
            if (jumpT >= 1) {
                jumping = false;
                row = destRow; col = destCol;
                if (!isValidPos(row, col)) break;
                dangerAdd(table, f, row, col, 1.0, maxFrames);
                idleTimer = ENEMY_IDLE_FRAMES;
                continue;
            }
            if (jumpT < 0.33) dangerAdd(table, f, row, col, 1.0, maxFrames);
            else if (jumpT >= 0.67 && destRow != null) dangerAdd(table, f, destRow, destCol, 1.0, maxFrames);
            continue;
        }

        if (idleTimer > 0) {
            dangerAdd(table, f, row, col, 1.0, maxFrames);
            idleTimer--;
            continue;
        }

        moveTimer++;
        if (moveTimer < interval) {
            dangerAdd(table, f, row, col, 1.0, maxFrames);
            continue;
        }
        moveTimer = 0;

        // Coily chase: pick direction closest to target
        var bestDist = Infinity, bestR = row, bestC = col;
        for (var k = 0; k < 4; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = row + dk.dr, nc = col + dk.dc;
            if (!isValidPos(nr, nc)) continue;
            var dist = Math.abs(targetR - nr) + Math.abs(targetC - nc);
            if (dist < bestDist) { bestDist = dist; bestR = nr; bestC = nc; }
        }
        dangerAdd(table, f, row, col, 1.0, maxFrames);
        destRow = bestR; destCol = bestC;
        jumping = true; jumpT = 0;
        if (!isValidPos(bestR, bestC)) break;
    }
    return table;
}

// Build danger table for a spawn-timer enemy.
function buildSpawnDangerTable(forcedType, spawnDelay, sm, maxFrames) {
    var jumpDur = ENEMY_JUMP_DUR * sm;
    var interval = enemyMoveInterval(forcedType, sm);
    if (forcedType === 'ugg') {
        var table = new Float32Array(maxFrames * POS_COUNT);
        expandEnemyPaths(table, 'ugg', ROWS-1, ROWS, true, 0, jumpDur,
            0, interval, 0, false, false, 0, ROWS-1, ROWS-1, 0,
            spawnDelay, maxFrames, sm, 1.0);
        return [table];
    }
    if (forcedType === 'wrongway') {
        var table = new Float32Array(maxFrames * POS_COUNT);
        expandEnemyPaths(table, 'wrongway', ROWS-1, -1, true, 0, jumpDur,
            0, interval, 0, false, false, 0, ROWS-1, 0, 0,
            spawnDelay, maxFrames, sm, 1.0);
        return [table];
    }
    // egg/redball: spawns at col 0 or col 1 (50/50)
    var tables = [];
    for (var sc = 0; sc < 2; sc++) {
        var t = new Float32Array(maxFrames * POS_COUNT);
        expandEnemyPaths(t, forcedType, 1, sc, false, 0, jumpDur,
            0, interval, 0, false, false, 60, null, null, 0,
            spawnDelay, maxFrames, sm, 0.5);
        tables.push(t);
    }
    return tables;
}

// ─── Multi-hop player tile timeline ─────────────────────────────────────────
// Build a player tile index array for a sequence of hops.
// Returns { idx: Int8Array[maxFrames], endFrame, endRow, endCol } or null if invalid.
// Each hop: jump frames + PLAYER_IDLE_FRAMES. STAY = sit at current pos for ~35 frames.

function computeHopFrames(sm) {
    return Math.ceil(1.0 / (PLAYER_JUMP_DUR * sm));
}

// Append one hop to a player timeline starting at startFrame.
// Returns the frame after landing idle completes, or -1 if the move is invalid.
function appendHop(result, pRow, pCol, dir, sm, startFrame, maxFrames) {
    if (dir === 'STAY') {
        var srcIdx = posToIdx[pRow * ROWS + pCol];
        var stayLen = computeHopFrames(sm) + PLAYER_IDLE_FRAMES;
        var endF = Math.min(startFrame + stayLen, maxFrames);
        for (var f = startFrame; f < endF; f++) result[f] = srcIdx;
        return { endFrame: endF, endRow: pRow, endCol: pCol };
    }
    var d = DIRS[dir];
    var destR = pRow + d.dr, destC = pCol + d.dc;
    if (!isValidPos(destR, destC)) return null;
    var srcIdx = posToIdx[pRow * ROWS + pCol];
    var dstIdx = posToIdx[destR * ROWS + destC];
    var jumpDur = PLAYER_JUMP_DUR * sm;
    var jumpT = 0;
    var landed = false;
    var idleCount = 0;
    for (var f = startFrame; f < maxFrames; f++) {
        if (!landed) {
            jumpT += jumpDur;
            if (jumpT >= 1) {
                landed = true;
                result[f] = dstIdx;
                continue;
            }
            if (jumpT < 0.33) result[f] = srcIdx;
            else if (jumpT >= 0.67) result[f] = dstIdx;
            // else: immune (-1)
        } else {
            result[f] = dstIdx;
            idleCount++;
            if (idleCount >= PLAYER_IDLE_FRAMES) {
                return { endFrame: f + 1, endRow: destR, endCol: destC };
            }
        }
    }
    // Ran out of frames
    return { endFrame: maxFrames, endRow: destR, endCol: destC };
}

// Build multi-hop player timeline for a sequence of directions.
// dirs = ['UL', 'DR', 'STAY'] etc.
// Returns { idx: Int8Array, endRow, endCol, validHops } or null if first hop invalid.
function buildMultiHopTimeline(pRow, pCol, dirs, sm, maxFrames) {
    var result = new Int8Array(maxFrames);
    for (var i = 0; i < maxFrames; i++) result[i] = -1;
    var curRow = pRow, curCol = pCol;
    var frame = 0;
    var validHops = 0;
    for (var h = 0; h < dirs.length; h++) {
        if (frame >= maxFrames) break;
        var hop = appendHop(result, curRow, curCol, dirs[h], sm, frame, maxFrames);
        if (!hop) {
            if (h === 0) return null; // first hop invalid
            break;
        }
        curRow = hop.endRow;
        curCol = hop.endCol;
        frame = hop.endFrame;
        validHops++;
    }
    return { idx: result, endRow: curRow, endCol: curCol, validHops: validHops };
}

// ─── Survival check against prebuilt enemy tables ───────────────────────────

// P(survive) against one enemy table over a player timeline.
function tableSurvivalProb(playerIdx, dangerTable, startFrame, endFrame) {
    var prob = 1.0;
    for (var f = startFrame; f < endFrame; f++) {
        var pi = playerIdx[f];
        if (pi >= 0) {
            var hitProb = dangerTable[f * POS_COUNT + pi];
            if (hitProb > 0) prob *= (1.0 - hitProb);
            if (prob <= 0) return 0;
        }
    }
    return prob;
}

// Check survival of a player timeline against all prebuilt non-Coily tables
// and a freshly built Coily table for this specific path.
function multiHopSurvival(playerTimeline, endFrame, coilyInit, coilyTargetR, coilyTargetC,
                          enemyTables, sm, startFrame) {
    var survProb = 1.0;
    // Non-Coily enemies (prebuilt, shared across all direction combos)
    for (var ti = 0; ti < enemyTables.length; ti++) {
        survProb *= tableSurvivalProb(playerTimeline, enemyTables[ti], startFrame, endFrame);
        if (survProb <= 0) return 0;
    }
    // Coily (depends on player path — rebuild per combo)
    if (coilyInit) {
        var ct = buildCoilyDangerTable(coilyInit, coilyTargetR, coilyTargetC, sm, endFrame);
        survProb *= tableSurvivalProb(playerTimeline, ct, startFrame, endFrame);
    }
    return survProb;
}

// ─── Dynamic peel routing (toggle levels) ───────────────────────────────────
// Stateless peel routing: each frame, look at the board and decide purely based on:
//   1. Static peel layers (computed once on the full pyramid graph)
//   2. Current cube states (stomps needed for each position)
// No cross-frame state — same board always produces the same decision.

var STATIC_PEEL = null;

function computePeelLayers(remaining) {
    var layer = new Int8Array(POS_COUNT);
    var degree = new Int8Array(POS_COUNT);
    var initDegree = new Int8Array(POS_COUNT);
    var removed = new Uint8Array(POS_COUNT);
    for (var i = 0; i < POS_COUNT; i++) {
        if (!remaining[i]) { removed[i] = 1; continue; }
        var deg = 0;
        var adj = posAdj[i];
        for (var a = 0; a < adj.length; a++) {
            if (remaining[adj[a]]) deg++;
        }
        degree[i] = deg;
        initDegree[i] = deg;
    }
    var count = 0;
    for (var i = 0; i < POS_COUNT; i++) if (remaining[i]) count++;
    var lay = 0;
    while (count > 0) {
        var minDeg = 99;
        for (var i = 0; i < POS_COUNT; i++) {
            if (!removed[i] && degree[i] < minDeg) minDeg = degree[i];
        }
        var batch = [];
        for (var i = 0; i < POS_COUNT; i++) {
            if (!removed[i] && degree[i] === minDeg) {
                batch.push(i);
                layer[i] = lay;
                removed[i] = 1;
                count--;
            }
        }
        for (var b = 0; b < batch.length; b++) {
            var adj = posAdj[batch[b]];
            for (var a = 0; a < adj.length; a++) {
                if (!removed[adj[a]]) degree[adj[a]]--;
            }
        }
        lay++;
    }
    return { layer: layer, degree: initDegree };
}

// Exported for viz
var PEEL_LAYER = null;
var PEEL_DEGREE = null;

function peelTargetDist(gs, forceFullGraph) {
    // Compute static peel layers once (full graph never changes)
    if (!STATIC_PEEL) {
        var full = new Uint8Array(POS_COUNT);
        for (var i = 0; i < POS_COUNT; i++) full[i] = 1;
        STATIC_PEEL = computePeelLayers(full);
    }

    // Current cube states
    var stomps = new Int8Array(POS_COUNT);
    for (var i = 0; i < gs.cubes.length; i++) {
        var idx = posToIdx[gs.cubes[i].row * ROWS + gs.cubes[i].col];
        stomps[idx] = stompsNeeded(gs.cubes[i].state, gs.lv);
    }

    // Export for viz
    PEEL_LAYER = STATIC_PEEL.layer;
    PEEL_DEGREE = STATIC_PEEL.degree;

    // Find lowest layer with uncompleted cubes
    var targetLayer = 99;
    for (var i = 0; i < POS_COUNT; i++) {
        if (stomps[i] > 0 && STATIC_PEEL.layer[i] < targetLayer)
            targetLayer = STATIC_PEEL.layer[i];
    }

    // Multi-source BFS from uncompleted cubes in target layer
    var dist = new Float64Array(POS_COUNT);
    for (var i = 0; i < POS_COUNT; i++) dist[i] = 999;
    if (targetLayer >= 99) return dist;
    var queue = [];
    for (var i = 0; i < POS_COUNT; i++) {
        if (stomps[i] > 0 && STATIC_PEEL.layer[i] === targetLayer) {
            dist[i] = 0;
            queue.push(i);
        }
    }
    var head = 0;
    while (head < queue.length) {
        var u = queue[head++];
        var adj = posAdj[u];
        for (var a = 0; a < adj.length; a++) {
            var v = adj[a];
            // On toggle levels, penalize routing through completed cubes (avoids reversion)
            var cost = dist[u] + 1;
            if (gs.lv >= 3 && stomps[v] <= 0) cost += 4;
            if (cost >= dist[v]) continue;
            dist[v] = cost;
            queue.push(v);
        }
    }
    return dist;
}

// ─── Can-move check ──────────────────────────────────────────────────────────
function simCanMove(gs, dirKey) {
    if (dirKey === 'STAY') return true;
    var d = DIRS[dirKey];
    var nr = gs.player.row + d.dr, nc = gs.player.col + d.dc;
    return isValidPos(nr, nc);
}

// ─── Direction selection ─────────────────────────────────────────────────────

function unifiedPick(gs) {
    var savedRng = simRng;
    function restoreRng() { simRng = savedRng; }

    // Shuffle direction keys to eliminate iteration-order bias
    // Use position-based seed so same position always gets same shuffle (no oscillation)
    var shuffleRng = createSeededRng(gs.player.row * 31 + gs.player.col * 97);
    var shuffledDirs = DIR_KEYS.slice();
    for (var si = shuffledDirs.length - 1; si > 0; si--) {
        var sj = Math.floor(shuffleRng() * (si + 1));
        var tmp = shuffledDirs[si]; shuffledDirs[si] = shuffledDirs[sj]; shuffledDirs[sj] = tmp;
    }
    var shuffledDirsStay = shuffledDirs.concat(['STAY']);

    var hasEnemies = gs.enemies.length > 0;

    // Capture decision-time enemy state for death debugging
    window._aiDecisionEnemies = gs.enemies.map(function(e) {
        if (e.type === 'spawn-timer') return 'spawn(' + (e.forcedType||'?') + ' t=' + e.timer + ')';
        var s = e.type + '@(' + e.row + ',' + e.col + ')';
        if (e.jumping) s += '→(' + e.destRow + ',' + e.destCol + ' t=' + (e.jumpT||0).toFixed(3) + ')';
        if (e.spawnDrop > 0) s += '[drop=' + e.spawnDrop + ']';
        s += '{mt=' + e.moveTimer + '/' + e.moveInterval + '}';
        return s;
    }).join(' ');

    // ── Build enemy danger tables once (shared across all direction combos) ──
    var maxFrames = DANGER_MAX_FRAMES;
    var startFrame = Math.min(gs.freezeTimer || 0, maxFrames);
    var enemyTables = []; // non-Coily tables
    var coilyInit = null; // Coily's initial state (if present)

    if (hasEnemies) {
        for (var ei = 0; ei < gs.enemies.length; ei++) {
            var e = gs.enemies[ei];
            if (e.type === 'spawn-timer') {
                if (e.timer <= maxFrames) {
                    var ft = e.forcedType;
                    if (!ft) {
                        var hasCoilyOrEgg = false;
                        for (var ci2 = 0; ci2 < gs.enemies.length; ci2++)
                            if (gs.enemies[ci2].type === 'coily' || gs.enemies[ci2].type === 'egg') { hasCoilyOrEgg = true; break; }
                        ft = hasCoilyOrEgg ? 'redball' : 'egg';
                    }
                    var spTables = buildSpawnDangerTable(ft, e.timer, gs.sm, maxFrames);
                    for (var sti = 0; sti < spTables.length; sti++) enemyTables.push(spTables[sti]);
                }
                continue;
            }
            if (e.type === 'slick' || e.type === 'sam' || e.type === 'greenball') continue;
            if (e.type === 'coily') {
                coilyInit = e;
                continue;
            }
            enemyTables.push(buildEnemyDangerTable(e, gs.sm, maxFrames));
        }
    }

    // ── Multi-hop survival: for each dir1, find best (dir2, dir3) survival ──
    var hop1Surv = {};
    var LOOKAHEAD_HOPS = 3;

    for (var k = 0; k < DIR_KEYS_WITH_STAY.length; k++) {
        var dir = DIR_KEYS_WITH_STAY[k];
        if (!simCanMove(gs, dir)) continue;

        if (!hasEnemies) {
            hop1Surv[dir] = 1.0;
            aiMoveScores[dir] = 10000;
            continue;
        }

        // Check spawnDrop collision for hop-1 dest
        var dd1 = DIRS[dir];
        var dest1R = dir === 'STAY' ? gs.player.row : gs.player.row + dd1.dr;
        var dest1C = dir === 'STAY' ? gs.player.col : gs.player.col + dd1.dc;
        var spawnDropBlock = false;
        for (var sdi = 0; sdi < gs.enemies.length; sdi++) {
            var sde = gs.enemies[sdi];
            if (sde.spawnDrop > 0 && sde.row === dest1R && sde.col === dest1C) { spawnDropBlock = true; break; }
        }
        if (spawnDropBlock) { hop1Surv[dir] = 0; aiMoveScores[dir] = 0; continue; }

        // Build hop-1 only timeline for quick check
        var hop1TL = buildMultiHopTimeline(gs.player.row, gs.player.col, [dir], gs.sm, maxFrames);
        if (!hop1TL) { hop1Surv[dir] = 0; aiMoveScores[dir] = 0; continue; }

        // Coily chases player's current pos during hop-1
        var hop1Surv1 = multiHopSurvival(hop1TL.idx, hop1TL.endFrame > maxFrames ? maxFrames : hop1TL.endFrame,
            coilyInit, gs.player.row, gs.player.col, enemyTables, gs.sm, startFrame);

        if (hop1Surv1 <= 0) {
            hop1Surv[dir] = 0;
            aiMoveScores[dir] = 0;
            continue;
        }

        // Multi-hop: find best 3-hop sequence starting with dir
        var bestMulti = 0;
        for (var d2k = 0; d2k < DIR_KEYS_WITH_STAY.length; d2k++) {
            var d2 = DIR_KEYS_WITH_STAY[d2k];
            // Quick validity check for hop-2
            if (d2 !== 'STAY' && !isValidPos(dest1R + DIRS[d2].dr, dest1C + DIRS[d2].dc)) continue;
            var dest2R = d2 === 'STAY' ? dest1R : dest1R + DIRS[d2].dr;
            var dest2C = d2 === 'STAY' ? dest1C : dest1C + DIRS[d2].dc;

            for (var d3k = 0; d3k < DIR_KEYS_WITH_STAY.length; d3k++) {
                var d3 = DIR_KEYS_WITH_STAY[d3k];
                if (d3 !== 'STAY' && !isValidPos(dest2R + DIRS[d3].dr, dest2C + DIRS[d3].dc)) continue;

                var tl = buildMultiHopTimeline(gs.player.row, gs.player.col, [dir, d2, d3], gs.sm, maxFrames);
                if (!tl || tl.validHops < 1) continue;

                var endF = Math.min(tl.endFrame || maxFrames, maxFrames);
                // Coily chases player's position; use current pos as target
                // (Coily doesn't know where player will hop next)
                var surv = multiHopSurvival(tl.idx, endF,
                    coilyInit, gs.player.row, gs.player.col, enemyTables, gs.sm, startFrame);
                if (surv > bestMulti) bestMulti = surv;
                if (bestMulti >= 1.0) break; // can't do better
            }
            if (bestMulti >= 1.0) break;
        }

        hop1Surv[dir] = bestMulti;
        aiMoveScores[dir] = Math.round(bestMulti * 10000);
    }

    // Safety threshold: directions with survival above this are considered safe
    var SAFE_THRESH = 0.9;

    // ── Opportunistic disc usage to kill Coily ──
    // Disc + lure always kills Coily (lure is off-grid, Coily chases it off edge).
    // No simulation needed — just check Coily exists and disc is reachable.
    var hasCoily = false;
    for (var ci = 0; ci < gs.enemies.length; ci++) {
        if (gs.enemies[ci].type === 'coily') { hasCoily = true; break; }
    }
    if (hasCoily) {
        for (var di = 0; di < gs.discs.length; di++) {
            var disc = gs.discs[di];
            if (!disc.active) continue;
            var trigRow = disc.row;
            var trigCol = disc.side === 0 ? 0 : disc.row;

            // Case 1: Already at disc trigger position → take disc immediately
            if (gs.player.row === trigRow && gs.player.col === trigCol) {
                var discDir = disc.side === 0 ? 'UL' : 'UR';
                console.log('DISC-KILL @(' + gs.player.row + ',' + gs.player.col + ') → ' + discDir);
                restoreRng(); return discDir;
            }

            // Case 2: One hop away from disc trigger → move toward it if safe
            for (var dk = 0; dk < shuffledDirs.length; dk++) {
                var ddir = shuffledDirs[dk];
                var dd = DIRS[ddir];
                var dr = gs.player.row + dd.dr, dc = gs.player.col + dd.dc;
                if (dr !== trigRow || dc !== trigCol) continue;
                if ((hop1Surv[ddir] || 0) < SAFE_THRESH) continue;
                console.log('DISC-APPROACH @(' + gs.player.row + ',' + gs.player.col + ') → ' + ddir + ' → disc');
                restoreRng(); return ddir;
            }
        }
    }

    // ── Peel-based direction selection ──
    var targetDist = peelTargetDist(gs);

    var bestDir = null, bestScore = Infinity;
    var _routeDbg = [];
    for (var fk = 0; fk < shuffledDirs.length; fk++) {
        var fd = shuffledDirs[fk];
        var fdd = DIRS[fd];
        var lr = gs.player.row + fdd.dr, lc = gs.player.col + fdd.dc;
        if (!isValidPos(lr, lc)) continue;
        var lidx = posToIdx[lr * ROWS + lc];
        var surv = hop1Surv[fd] || 0;
        if (surv < SAFE_THRESH) { _routeDbg.push(fd + '→(' + lr + ',' + lc + ') P=' + surv.toFixed(2)); continue; }
        if (lidx < 0) continue;

        var score = targetDist[lidx];
        var _stompsHere = 0;
        for (var _ci = 0; _ci < gs.cubes.length; _ci++) {
            if (gs.cubes[_ci].row === lr && gs.cubes[_ci].col === lc) {
                _stompsHere = stompsNeeded(gs.cubes[_ci].state, gs.lv); break;
            }
        }
        _routeDbg.push(fd + '→(' + lr + ',' + lc + ') dist=' + score.toFixed(1) + ' P=' + surv.toFixed(2) + ' L=' + STATIC_PEEL.layer[lidx]);
        if (score >= 999) continue;
        // Tiebreaker: prefer cubes with more neighbors (avoid dead-end corners)
        score -= posAdj[lidx].length * 0.01;
        if (score < bestScore) { bestScore = score; bestDir = fd; }
    }
    if (bestDir) {
        console.log('PEEL-ROUTE @(' + gs.player.row + ',' + gs.player.col + ') → ' + bestDir + ' P=' + (hop1Surv[bestDir]||0).toFixed(2) + ' | ' + _routeDbg.join(' | '));
        restoreRng(); return bestDir;
    }

    // Peel BFS found no path — fall back to simple BFS on the full graph.
    if (gs.lv >= 3) {
        targetDist = peelTargetDist(gs, true);
        var maxLayer = 0;
        for (var pl = 0; pl < POS_COUNT; pl++)
            if (STATIC_PEEL.layer[pl] > maxLayer) maxLayer = STATIC_PEEL.layer[pl];
        bestDir = null; bestScore = Infinity;
        for (var fk2 = 0; fk2 < shuffledDirs.length; fk2++) {
            var fd2 = shuffledDirs[fk2];
            var fdd2 = DIRS[fd2];
            var lr2 = gs.player.row + fdd2.dr, lc2 = gs.player.col + fdd2.dc;
            if (!isValidPos(lr2, lc2)) continue;
            var lidx2 = posToIdx[lr2 * ROWS + lc2];
            if ((hop1Surv[fd2] || 0) < SAFE_THRESH) continue;
            if (lidx2 < 0) continue;
            var score2 = targetDist[lidx2];
            if (score2 >= 999) continue;
            var _stomps2 = 0;
            for (var _ci2 = 0; _ci2 < gs.cubes.length; _ci2++) {
                if (gs.cubes[_ci2].row === lr2 && gs.cubes[_ci2].col === lc2) {
                    _stomps2 = stompsNeeded(gs.cubes[_ci2].state, gs.lv); break;
                }
            }
            if (_stomps2 <= 0) {
                score2 += (maxLayer - STATIC_PEEL.layer[lidx2]) * 0.3;
            }
            score2 -= posAdj[lidx2].length * 0.01;
            if (score2 < bestScore) { bestScore = score2; bestDir = fd2; }
        }
        if (bestDir) {
            console.log('PEEL-FALLBACK @(' + gs.player.row + ',' + gs.player.col + ') → ' + bestDir + ' P=' + (hop1Surv[bestDir]||0).toFixed(2));
            restoreRng(); return bestDir;
        }
    }

    console.log('PEEL-NONE @(' + gs.player.row + ',' + gs.player.col + ') | ' + _routeDbg.join(' | '));
    // No safe movement direction — pick by survival probability, tie-break by routing
    var bestFallback = -Infinity, bestFallbackDir = null;
    for (var uk = 0; uk < shuffledDirsStay.length; uk++) {
        var ud = shuffledDirsStay[uk];
        if (hop1Surv[ud] === undefined) continue;
        var fallbackScore = hop1Surv[ud] * 1000;
        if (ud === 'STAY') {
            fallbackScore -= 50;
        } else {
            var udd = DIRS[ud];
            var fur = gs.player.row + udd.dr, fuc = gs.player.col + udd.dc;
            if (isValidPos(fur, fuc)) {
                var fuidx = posToIdx[fur * ROWS + fuc];
                if (fuidx >= 0 && targetDist[fuidx] < 999) {
                    fallbackScore -= targetDist[fuidx];
                }
            }
        }
        if (fallbackScore > bestFallback) {
            bestFallback = fallbackScore; bestFallbackDir = ud;
        }
    }
    restoreRng();
    return bestFallbackDir || 'STAY';
}

// ─── Main entry point ────────────────────────────────────────────────────────
var aiMoveScores = {};
var aiMode = 0;
var _aiDecisionHistory = [];

function aiPickBestDir() {
    var savedGameRng = simRng;

    var gs = simCloneGameState();
    aiMoveScores = {};
    aiMode = 1;

    var result = unifiedPick(gs);

    // Record rolling history of last 5 decisions for death debugging
    var scores = '';
    for (var dk in aiMoveScores) scores += dk + '=' + Math.round(aiMoveScores[dk]) + ' ';
    _aiDecisionHistory.push('hop' + (hops||0) + ' @(' + gs.player.row + ',' + gs.player.col + ') → ' + result + ' [' + scores.trim() + ']');
    if (_aiDecisionHistory.length > 5) _aiDecisionHistory.shift();

    simRng = savedGameRng;
    return result;
}
