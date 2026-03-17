// qbert-ai.js — Q*bert AI logic (peel routing)
var AI_VERSION = 'v13.9';
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

var EXHAUSTIVE_RADIUS = 5;

function computePlayerTiles(pRow, pCol, dir, sm) {
    if (dir === 'STAY') {
        var maxWait = Math.ceil(1.0 / (PLAYER_JUMP_DUR * sm)) + 10;
        var tiles = [];
        for (var f = 0; f < maxWait; f++) tiles.push({ row: pRow, col: pCol });
        return tiles;
    }
    var d = DIRS[dir];
    var destR = pRow + d.dr, destC = pCol + d.dc;
    if (!isValidPos(destR, destC)) return null;
    var jumpDur = PLAYER_JUMP_DUR * sm;
    var tiles = [];
    var jumpT = 0;
    var landed = false;
    var idleFrames = 0;
    for (var f = 0; f < 120; f++) {
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
            tiles.push({ row: destR, col: destC });
            idleFrames++;
            if (idleFrames >= 30) break;
        }
    }
    return tiles;
}

function cloneEnemyLight(e) {
    return {
        type: e.type, row: e.row, col: e.col,
        jumping: e.jumping, jumpT: e.jumpT, jumpDur: e.jumpDur,
        destRow: e.destRow, destCol: e.destCol,
        moveTimer: e.moveTimer, moveInterval: e.moveInterval,
        hops: e.hops || 0, falling: e.falling || false,
        willHatch: e.willHatch || false,
        spawnDrop: e.spawnDrop || 0
    };
}

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

function enemyCollisionTile(e) {
    if (!e.jumping) return { row: e.row, col: e.col };
    if (e.jumpT < 0.33) return { row: e.row, col: e.col };
    if (e.jumpT >= 0.67) return { row: e.destRow, col: e.destCol };
    return null;
}

function enemyPathCollides(e, playerTiles, frame, maxFrames, pDestR, pDestC, sm) {
    if (frame >= maxFrames || e.falling) return false;

    // Still dropping from sky — no collision, just tick down
    if (e.spawnDrop > 0) {
        e.spawnDrop--;
        return enemyPathCollides(e, playerTiles, frame + 1, maxFrames, pDestR, pDestC, sm);
    }

    if (e.jumping) {
        e.jumpT += e.jumpDur;
        if (e.jumpT >= 1) {
            e.jumping = false;
            e.row = e.destRow; e.col = e.destCol;
            if (!isValidPos(e.row, e.col)) return false;
            if (e.type === 'egg' && ((e.hops || 0) >= 6 || e.row >= ROWS - 1)) {
                e.type = 'coily';
                e.moveInterval = enemyMoveInterval('coily', sm);
            }
        }
        var et = enemyCollisionTile(e);
        var pt = playerTiles[frame];
        if (et && pt && et.row === pt.row && et.col === pt.col) return true;
        return enemyPathCollides(e, playerTiles, frame + 1, maxFrames, pDestR, pDestC, sm);
    }

    e.moveTimer++;
    if (e.moveTimer < e.moveInterval) {
        var pt2 = playerTiles[frame];
        if (pt2 && pt2.row === e.row && pt2.col === e.col) return true;
        return enemyPathCollides(e, playerTiles, frame + 1, maxFrames, pDestR, pDestC, sm);
    }

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
        var pt3 = playerTiles[frame];
        if (pt3 && pt3.row === ec.row && pt3.col === ec.col) return true;
        if (enemyPathCollides(ec, playerTiles, frame + 1, maxFrames, pDestR, pDestC, sm)) {
            return true;
        }
    }
    return false;
}

function isExhaustiveSafe(gs, dir) {
    var playerTiles = computePlayerTiles(gs.player.row, gs.player.col, dir, gs.sm);
    if (!playerTiles) return true;

    var d = DIRS[dir];
    var destR = dir === 'STAY' ? gs.player.row : gs.player.row + d.dr;
    var destC = dir === 'STAY' ? gs.player.col : gs.player.col + d.dc;
    var maxFrames = playerTiles.length;
    var startFrame = Math.min(gs.freezeTimer || 0, maxFrames);

    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];

        if (e.type === 'spawn-timer') {
            if (e.timer <= maxFrames) {
                var ft = e.forcedType;
                if (!ft) {
                    var hasCoilyOrEgg = false;
                    for (var ci = 0; ci < gs.enemies.length; ci++)
                        if (gs.enemies[ci].type === 'coily' || gs.enemies[ci].type === 'egg') { hasCoilyOrEgg = true; break; }
                    ft = hasCoilyOrEgg ? 'redball' : 'egg';
                }
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

        if (e.type === 'slick' || e.type === 'greenball') continue;

        // Don't land on a tile where an enemy is dropping or sitting after drop
        if (e.spawnDrop > 0 && e.row === destR && e.col === destC) return false;

        var er = e.jumping && e.jumpT >= 0.67 ? (e.destRow != null ? e.destRow : e.row) : e.row;
        var ec2 = e.jumping && e.jumpT >= 0.67 ? (e.destCol != null ? e.destCol : e.col) : e.col;
        if (e.type !== 'coily') {
            var distDest = Math.abs(er - destR) + Math.abs(ec2 - destC);
            var distSrc = Math.abs(er - gs.player.row) + Math.abs(ec2 - gs.player.col);
            if (distDest > EXHAUSTIVE_RADIUS && distSrc > EXHAUSTIVE_RADIUS) continue;
        }

        var eClone = cloneEnemyLight(e);
        if (enemyPathCollides(eClone, playerTiles, startFrame, maxFrames, destR, destC, gs.sm)) {
            return false;
        }
    }
    return true;
}

// ─── Dynamic peel routing (toggle levels) ───────────────────────────────────
// Maintains a "remaining" set across frames. Each frame:
//   1. Compute peel layers on remaining subgraph
//   2. Any completed cube in the lowest peel layer → remove from remaining, recompute
//   3. Target = closest uncompleted cube in lowest peel layer (BFS on remaining)
//   4. Route toward target

var peelRemaining = null;
var peelRound = -1;

function peelReset() {
    peelRemaining = new Uint8Array(POS_COUNT);
    for (var i = 0; i < POS_COUNT; i++) peelRemaining[i] = 1;
}

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
    var roundId = (gs.round || 0) * 1000 + (gs.lv || 0);
    if (!peelRemaining || peelRound !== roundId) {
        peelReset();
        peelRound = roundId;
    }

    var stomps = new Int8Array(POS_COUNT);
    for (var i = 0; i < gs.cubes.length; i++) {
        var idx = posToIdx[gs.cubes[i].row * ROWS + gs.cubes[i].col];
        stomps[idx] = stompsNeeded(gs.cubes[i].state, gs.lv);
    }

    // Repair: if a removed cube got reverted (slick, etc.), add it back
    for (var i = 0; i < POS_COUNT; i++) {
        if (!peelRemaining[i] && stomps[i] > 0) peelRemaining[i] = 1;
    }

    // Iteratively: compute peel layers, remove completed cubes from lowest layer
    var peel;
    for (var iter = 0; iter < POS_COUNT; iter++) {
        peel = computePeelLayers(peelRemaining);
        var minLayer = 99;
        for (var i = 0; i < POS_COUNT; i++) {
            if (!peelRemaining[i]) continue;
            if (peel.layer[i] < minLayer) minLayer = peel.layer[i];
        }
        if (minLayer >= 99) break;
        var removedAny = false;
        for (var i = 0; i < POS_COUNT; i++) {
            if (!peelRemaining[i]) continue;
            if (peel.layer[i] !== minLayer) continue;
            if (stomps[i] <= 0) {
                peelRemaining[i] = 0;
                removedAny = true;
            }
        }
        if (!removedAny) break;
    }

    // Export for viz
    PEEL_LAYER = peel.layer;
    PEEL_DEGREE = peel.degree;

    // Find lowest layer with uncompleted cubes
    var minLayer = 99;
    for (var i = 0; i < POS_COUNT; i++) {
        if (!peelRemaining[i]) continue;
        if (stomps[i] <= 0) continue;
        if (peel.layer[i] < minLayer) minLayer = peel.layer[i];
    }

    // Multi-source BFS from all uncompleted cubes in lowest layer, on remaining graph
    var dist = new Float64Array(POS_COUNT);
    for (var i = 0; i < POS_COUNT; i++) dist[i] = 999;
    if (minLayer >= 99) return dist;
    var queue = [];
    for (var i = 0; i < POS_COUNT; i++) {
        if (peelRemaining[i] && stomps[i] > 0 && peel.layer[i] === minLayer) {
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
            if (dist[v] < 999) continue;
            if (!forceFullGraph && gs.lv >= 3 && !peelRemaining[v]) continue;
            dist[v] = dist[u] + 1 + (stomps[v] <= 0 ? 0.4 : 0);
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
    var baseSeed = (gs.player.row * 7 + gs.player.col) * 10000 + (frameCount || 0);
    function simSeed(sampleIdx) { simRng = createSeededRng(baseSeed + sampleIdx * 9973); }
    function restoreRng() { simRng = savedRng; }

    var hasEnemies = gs.enemies.length > 0;

    // ── Safety check for each direction (exhaustive + hop-2/3 chain) ──
    var safe1 = {};
    var safe2 = {};
    var hop1Surv = {};

    for (var k = 0; k < DIR_KEYS_WITH_STAY.length; k++) {
        var dir = DIR_KEYS_WITH_STAY[k];
        if (!simCanMove(gs, dir)) continue;

        // Exhaustive safety check (covers all enemies including Coily)
        if (!hasEnemies) {
            safe1[dir] = true;
        } else if (dir === 'STAY') {
            var stayFrames = 10;
            var stayTiles = [];
            for (var sf = 0; sf < stayFrames; sf++) stayTiles.push({ row: gs.player.row, col: gs.player.col });
            var stayUnsafe = false;
            for (var sei = 0; sei < gs.enemies.length; sei++) {
                var se = gs.enemies[sei];
                if (se.type === 'spawn-timer' || se.type === 'slick' || se.type === 'greenball') continue;
                var ser = se.jumping && se.jumpT >= 0.67 ? (se.destRow != null ? se.destRow : se.row) : se.row;
                var sec = se.jumping && se.jumpT >= 0.67 ? (se.destCol != null ? se.destCol : se.col) : se.col;
                if (se.type !== 'coily' && Math.abs(ser - gs.player.row) + Math.abs(sec - gs.player.col) > 2) continue;
                var seClone = cloneEnemyLight(se);
                if (enemyPathCollides(seClone, stayTiles, 0, stayFrames, gs.player.row, gs.player.col, gs.sm)) {
                    stayUnsafe = true; break;
                }
            }
            safe1[dir] = !stayUnsafe;
        } else {
            safe1[dir] = isExhaustiveSafe(gs, dir);
        }
        // MC sampling for future states and fallback survival ranking
        var hop1States = [];
        var survived = 0;
        for (var s = 0; s < 8; s++) {
            simSeed(k * 100 + s);
            var child = simDeepClone(gs);
            if (simStep(child, dir)) {
                survived++;
                if (hop1States.length < 4) hop1States.push(child);
            }
        }
        hop1Surv[dir] = safe1[dir] ? 1 : survived / 8;

        // Export for viz
        aiMoveScores[dir] = safe1[dir] ? 10000 : (survived > 0 ? survived * 100 - 1000 : -10000);

        // Hop 2+3 chain check (anti-cornering)
        if (safe1[dir] && hasEnemies && dir !== 'STAY') {
            var has2ndSafe = false;
            for (var d2k = 0; d2k < DIR_KEYS_WITH_STAY.length; d2k++) {
                var d2dir = DIR_KEYS_WITH_STAY[d2k];
                var d2ok = true;
                var hop2States = [];
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
                if (d2ok && d2dir !== 'STAY') {
                    for (var si2 = 0; si2 < hop1States.length; si2++) {
                        if (!isExhaustiveSafe(hop1States[si2], d2dir)) { d2ok = false; break; }
                    }
                }
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
            if (!has2ndSafe) aiMoveScores[dir] = -5000;
        } else if (dir === 'STAY' && hasEnemies) {
            var canEscape = false;
            for (var ek = 0; ek < DIR_KEYS.length; ek++) {
                if (safe1[DIR_KEYS[ek]]) { canEscape = true; break; }
            }
            safe2[dir] = canEscape;
        } else {
            safe2[dir] = true;
        }
    }

    // ── Peel-based direction selection ──
    var targetDist = peelTargetDist(gs);

    var bestDir = null, bestScore = Infinity;
    for (var fk = 0; fk < DIR_KEYS.length; fk++) {
        var fd = DIR_KEYS[fk];
        var fdd = DIRS[fd];
        var lr = gs.player.row + fdd.dr, lc = gs.player.col + fdd.dc;
        if (!isValidPos(lr, lc)) continue;
        var lidx = posToIdx[lr * ROWS + lc];
        if (!safe1[fd] || !safe2[fd]) continue;
        if (lidx < 0) continue;

        var score = targetDist[lidx];
        if (score >= 999) continue;

        if (score < bestScore) { bestScore = score; bestDir = fd; }
    }
    if (bestDir) { restoreRng(); return bestDir; }

    // Peel BFS found no path (e.g. respawn at apex, separated from targets by
    // removed cubes). Fall back to simple BFS on the full graph to reconnect.
    // Prefer reverting high-layer (interior) cubes over low-layer (edge) cubes.
    if (gs.lv >= 3) {
        targetDist = peelTargetDist(gs, true);
        var maxLayer = 0;
        if (PEEL_LAYER) {
            for (var pl = 0; pl < POS_COUNT; pl++)
                if (PEEL_LAYER[pl] > maxLayer) maxLayer = PEEL_LAYER[pl];
        }
        bestDir = null; bestScore = Infinity;
        for (var fk2 = 0; fk2 < DIR_KEYS.length; fk2++) {
            var fd2 = DIR_KEYS[fk2];
            var fdd2 = DIRS[fd2];
            var lr2 = gs.player.row + fdd2.dr, lc2 = gs.player.col + fdd2.dc;
            if (!isValidPos(lr2, lc2)) continue;
            var lidx2 = posToIdx[lr2 * ROWS + lc2];
            if (!safe1[fd2] || !safe2[fd2]) continue;
            if (lidx2 < 0) continue;
            var score2 = targetDist[lidx2];
            if (score2 >= 999) continue;
            // Penalize stepping on low-layer (edge) completed cubes — prefer reverting interior
            if (PEEL_LAYER && !peelRemaining[lidx2]) {
                score2 += (maxLayer - PEEL_LAYER[lidx2]) * 0.1;
            }
            if (score2 < bestScore) { bestScore = score2; bestDir = fd2; }
        }
        if (bestDir) { restoreRng(); return bestDir; }
    }

    // No fully-safe option — pick by survival, tie-break by routing.
    // STAY is last resort (lets enemies converge).
    var bestFallback = -Infinity, bestFallbackDir = null;
    for (var uk = 0; uk < DIR_KEYS_WITH_STAY.length; uk++) {
        var ud = DIR_KEYS_WITH_STAY[uk];
        if (hop1Surv[ud] === undefined) continue;
        // Primary: survival rate (0-1). Secondary: routing score.
        var fallbackScore = hop1Surv[ud] * 1000;
        if (ud === 'STAY') {
            fallbackScore -= 50; // penalize staying still
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

function aiPickBestDir() {
    var savedGameRng = simRng;

    var gs = simCloneGameState();
    aiMoveScores = {};
    aiMode = 1;

    var result = unifiedPick(gs);

    simRng = savedGameRng;
    return result;
}
