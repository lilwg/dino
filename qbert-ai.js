// qbert-ai.js — Q*bert AI logic (peel routing)
var AI_VERSION = 'v15.0-memoized';
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
        spawnDrop: e.spawnDrop || 0,
        idleTimer: e.idleTimer || 0
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
            if (dist < bestDist || (dist === bestDist && simRng() < 0.5)) { bestDist = dist; bestR = tr; bestC = tc; }
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
            e.idleTimer = ENEMY_IDLE_FRAMES; // post-landing idle pause
        }
        var et = enemyCollisionTile(e);
        var pt = playerTiles[frame];
        if (et && pt && et.row === pt.row && et.col === pt.col) return true;
        return enemyPathCollides(e, playerTiles, frame + 1, maxFrames, pDestR, pDestC, sm);
    }

    // Post-landing idle pause
    if (e.idleTimer > 0) {
        e.idleTimer--;
        var pt0 = playerTiles[frame];
        if (pt0 && pt0.row === e.row && pt0.col === e.col) return true;
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
                if (ft === 'wrongway') {
                    var we = { type: 'wrongway', row: ROWS-1, col: -1,
                        jumping: true, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * gs.sm,
                        destRow: ROWS-1, destCol: 0,
                        moveTimer: 0, moveInterval: enemyMoveInterval('wrongway', gs.sm),
                        hops: 0, falling: false, spawnDrop: 0 };
                    if (enemyPathCollides(we, playerTiles, e.timer, maxFrames, chaseR, chaseC, gs.sm))
                        return false;
                }
                if (ft === 'ugg') {
                    var ue = { type: 'ugg', row: ROWS-1, col: ROWS,
                        jumping: true, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * gs.sm,
                        destRow: ROWS-1, destCol: ROWS-1,
                        moveTimer: 0, moveInterval: enemyMoveInterval('ugg', gs.sm),
                        hops: 0, falling: false, spawnDrop: 0 };
                    if (enemyPathCollides(ue, playerTiles, e.timer, maxFrames, chaseR, chaseC, gs.sm))
                        return false;
                }
            }
            continue;
        }

        if (e.type === 'slick' || e.type === 'sam' || e.type === 'greenball') continue;

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
        // Coily chases gs.player.row/col which stays at ORIGIN during hop
        var chaseR = gs.player.row, chaseC = gs.player.col;
        if (enemyPathCollides(eClone, playerTiles, startFrame, maxFrames, chaseR, chaseC, gs.sm)) {
            return false;
        }
    }
    return true;
}

// ─── Precomputed enemy danger tables (verified frame-accurate) ──────────────
// For multi-hop lookahead: precompute per-enemy probability tables once,
// then check any player path against them with simple array lookups.
// Non-Coily enemies are player-independent. Coily depends on player path.

var DANGER_MAX_FRAMES = 200; // 5 hops × ~35 frames + buffer

function dangerAdd(table, frame, row, col, prob, maxFrames) {
    if (frame >= maxFrames) return;
    var idx = posToIdx[row * ROWS + col];
    if (idx >= 0) table[frame * POS_COUNT + idx] += prob;
}

function getMoveChoicesForType(type, row, col) {
    if (type === 'egg' || type === 'redball')
        return [[row + 1, col], [row + 1, col + 1]];
    if (type === 'ugg')
        return [[row - 1, col - 1], [row, col - 1]];
    if (type === 'wrongway')
        return [[row - 1, col], [row, col + 1]];
    return [];
}

// Recursively expand all possible enemy paths with probability tracking.
// Verified frame-accurate against simUpdateEnemies (test-danger-table.js).
function expandEnemyPaths(table, type, row, col, jumping, jumpT, jumpDur,
                          moveTimer, moveInterval, hops, falling, willHatch,
                          spawnDrop, destRow, destCol, idleTimer,
                          frame, maxFrames, sm, prob) {
    if (frame >= maxFrames) return;
    if (falling) {
        if (jumping) {
            var newJT = jumpT + jumpDur;
            if (newJT < 0.33) {
                dangerAdd(table, frame, row, col, prob, maxFrames);
                expandEnemyPaths(table, type, row, col, true, newJT, jumpDur,
                    moveTimer, moveInterval, hops, true, willHatch,
                    0, destRow, destCol, idleTimer, frame + 1, maxFrames, sm, prob);
            } else if (newJT < 0.67) {
                expandEnemyPaths(table, type, row, col, true, newJT, jumpDur,
                    moveTimer, moveInterval, hops, true, willHatch,
                    0, destRow, destCol, idleTimer, frame + 1, maxFrames, sm, prob);
            }
        }
        return;
    }
    if (spawnDrop > 0) {
        expandEnemyPaths(table, type, row, col, jumping, jumpT, jumpDur,
            moveTimer, moveInterval, hops, falling, willHatch,
            spawnDrop - 1, destRow, destCol, idleTimer, frame + 1, maxFrames, sm, prob);
        return;
    }
    if (jumping) {
        var newJumpT = jumpT + jumpDur;
        if (newJumpT >= 1) {
            var landRow = destRow, landCol = destCol;
            if (!isValidPos(landRow, landCol)) return;
            var newType = type, newInterval = moveInterval, newWillHatch = false;
            if (type === 'egg' && (hops >= 6 || landRow >= ROWS - 1 || willHatch)) {
                newType = 'coily';
                dangerAdd(table, frame, landRow, landCol, prob, maxFrames);
                for (var ef = 1; ef <= 10; ef++)
                    dangerAdd(table, frame + ef, landRow, landCol, prob, maxFrames);
                return;
            }
            dangerAdd(table, frame, landRow, landCol, prob, maxFrames);
            expandEnemyPaths(table, newType, landRow, landCol, false, 0, jumpDur,
                0, newInterval, hops, false, newWillHatch,
                0, null, null, ENEMY_IDLE_FRAMES, frame + 1, maxFrames, sm, prob);
        } else {
            if (newJumpT < 0.33) dangerAdd(table, frame, row, col, prob, maxFrames);
            else if (newJumpT >= 0.67) {
                if (destRow != null) dangerAdd(table, frame, destRow, destCol, prob, maxFrames);
            }
            expandEnemyPaths(table, type, row, col, true, newJumpT, jumpDur,
                moveTimer, moveInterval, hops, falling, willHatch,
                0, destRow, destCol, idleTimer, frame + 1, maxFrames, sm, prob);
        }
        return;
    }
    if (idleTimer > 0) {
        dangerAdd(table, frame, row, col, prob, maxFrames);
        expandEnemyPaths(table, type, row, col, false, 0, jumpDur,
            moveTimer, moveInterval, hops, false, willHatch,
            0, null, null, idleTimer - 1, frame + 1, maxFrames, sm, prob);
        return;
    }
    var newMoveTimer = moveTimer + 1;
    if (newMoveTimer < moveInterval) {
        dangerAdd(table, frame, row, col, prob, maxFrames);
        expandEnemyPaths(table, type, row, col, false, 0, jumpDur,
            newMoveTimer, moveInterval, hops, false, willHatch,
            0, null, null, 0, frame + 1, maxFrames, sm, prob);
        return;
    }
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
            0, nr, nc, 0, frame + 1, maxFrames, sm, branchProb);
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
        e.spawnDrop || 0,
        e.destRow != null ? e.destRow : null,
        e.destCol != null ? e.destCol : null,
        e.idleTimer || 0,
        0, maxFrames, sm, 1.0);
    return table;
}

// Coily danger table: waypoint-aware chase target, branches on ties.
function buildCoilyDangerTable(e, waypoints, sm, maxFrames) {
    var table = new Float32Array(maxFrames * POS_COUNT);
    var jumpDur = e.jumpDur || ENEMY_JUMP_DUR * sm;
    var interval = e.moveInterval || enemyMoveInterval('coily', sm);
    expandCoilyPaths(table, e.row, e.col, !!e.jumping, e.jumpT || 0, jumpDur,
        e.moveTimer || 0, interval, e.idleTimer || 0, e.spawnDrop || 0,
        e.destRow != null ? e.destRow : null, e.destCol != null ? e.destCol : null,
        waypoints, 0, maxFrames, sm, 1.0);
    return table;
}

function expandCoilyPaths(table, row, col, jumping, jumpT, jumpDur,
                          moveTimer, moveInterval, idleTimer, spawnDrop,
                          destRow, destCol, waypoints, frame, maxFrames, sm, prob) {
    if (frame >= maxFrames || prob < 0.001) return;
    var targetR = waypoints[0].row, targetC = waypoints[0].col;
    for (var w = 1; w < waypoints.length; w++) {
        if (waypoints[w].frame <= frame) { targetR = waypoints[w].row; targetC = waypoints[w].col; }
        else break;
    }
    if (spawnDrop > 0) {
        expandCoilyPaths(table, row, col, jumping, jumpT, jumpDur,
            moveTimer, moveInterval, idleTimer, spawnDrop - 1,
            destRow, destCol, waypoints, frame + 1, maxFrames, sm, prob);
        return;
    }
    if (jumping) {
        var newJT = jumpT + jumpDur;
        if (newJT >= 1) {
            if (!isValidPos(destRow, destCol)) return;
            dangerAdd(table, frame, destRow, destCol, prob, maxFrames);
            expandCoilyPaths(table, destRow, destCol, false, 0, jumpDur,
                0, moveInterval, ENEMY_IDLE_FRAMES, 0, null, null,
                waypoints, frame + 1, maxFrames, sm, prob);
        } else {
            if (newJT < 0.33) dangerAdd(table, frame, row, col, prob, maxFrames);
            else if (newJT >= 0.67 && destRow != null) dangerAdd(table, frame, destRow, destCol, prob, maxFrames);
            expandCoilyPaths(table, row, col, true, newJT, jumpDur,
                moveTimer, moveInterval, idleTimer, 0, destRow, destCol,
                waypoints, frame + 1, maxFrames, sm, prob);
        }
        return;
    }
    if (idleTimer > 0) {
        dangerAdd(table, frame, row, col, prob, maxFrames);
        expandCoilyPaths(table, row, col, false, 0, jumpDur,
            moveTimer, moveInterval, idleTimer - 1, 0, null, null,
            waypoints, frame + 1, maxFrames, sm, prob);
        return;
    }
    moveTimer++;
    if (moveTimer < moveInterval) {
        dangerAdd(table, frame, row, col, prob, maxFrames);
        expandCoilyPaths(table, row, col, false, 0, jumpDur,
            moveTimer, moveInterval, 0, 0, null, null,
            waypoints, frame + 1, maxFrames, sm, prob);
        return;
    }
    var bestDist = Infinity, choices = [];
    for (var k = 0; k < 4; k++) {
        var dk = DIRS[DIR_KEYS[k]];
        var nr = row + dk.dr, nc = col + dk.dc;
        if (!isValidPos(nr, nc)) continue;
        var dist = Math.abs(targetR - nr) + Math.abs(targetC - nc);
        if (dist < bestDist) { bestDist = dist; choices = [[nr, nc]]; }
        else if (dist === bestDist) { choices.push([nr, nc]); }
    }
    dangerAdd(table, frame, row, col, prob, maxFrames);
    if (choices.length === 0) return;
    var branchProb = prob / choices.length;
    for (var ci = 0; ci < choices.length; ci++) {
        expandCoilyPaths(table, row, col, true, 0, jumpDur,
            0, moveInterval, 0, 0, choices[ci][0], choices[ci][1],
            waypoints, frame + 1, maxFrames, sm, branchProb);
    }
}

// Fast deterministic Coily table: O(maxFrames) loop, no branching.
// On ties, picks first best direction (deterministic). Waypoint-aware.
function buildCoilyDangerTableFast(e, waypoints, sm, maxFrames) {
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
        // Get chase target from waypoints
        var targetR = waypoints[0].row, targetC = waypoints[0].col;
        for (var w = 1; w < waypoints.length; w++) {
            if (waypoints[w].frame <= f) { targetR = waypoints[w].row; targetC = waypoints[w].col; }
            else break;
        }

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
        // Chase: pick first best direction (deterministic, no tie branching)
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

function buildSpawnDangerTable(forcedType, spawnDelay, sm, maxFrames) {
    var jumpDur = ENEMY_JUMP_DUR * sm;
    var interval = enemyMoveInterval(forcedType, sm);
    if (forcedType === 'ugg') {
        var t = new Float32Array(maxFrames * POS_COUNT);
        expandEnemyPaths(t, 'ugg', ROWS-1, ROWS, true, 0, jumpDur,
            0, interval, 0, false, false, 0, ROWS-1, ROWS-1, 0,
            spawnDelay, maxFrames, sm, 1.0);
        return [t];
    }
    if (forcedType === 'wrongway') {
        var t = new Float32Array(maxFrames * POS_COUNT);
        expandEnemyPaths(t, 'wrongway', ROWS-1, -1, true, 0, jumpDur,
            0, interval, 0, false, false, 0, ROWS-1, 0, 0,
            spawnDelay, maxFrames, sm, 1.0);
        return [t];
    }
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

// ─── Multi-hop survival via danger tables ───────────────────────────────────

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

function appendHop(result, pRow, pCol, dir, sm, startFrame, maxFrames) {
    if (dir === 'STAY') {
        var srcIdx = posToIdx[pRow * ROWS + pCol];
        var stayLen = Math.ceil(1.0 / (PLAYER_JUMP_DUR * sm)) + PLAYER_IDLE_FRAMES;
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
    var jumpT = 0;
    var landed = false;
    var idleCount = 0;
    var landFrame = -1;
    for (var f = startFrame; f < maxFrames; f++) {
        if (!landed) {
            jumpT += jumpDur;
            if (jumpT >= 1) {
                landed = true; landFrame = f;
                result[f] = dstIdx;
                continue;
            }
            if (jumpT < 0.33) result[f] = srcIdx;
            else if (jumpT >= 0.67) result[f] = dstIdx;
        } else {
            result[f] = dstIdx;
            idleCount++;
            if (idleCount >= PLAYER_IDLE_FRAMES) {
                return { endFrame: f + 1, endRow: destR, endCol: destC, landFrame: landFrame };
            }
        }
    }
    return { endFrame: maxFrames, endRow: destR, endCol: destC, landFrame: landFrame };
}

var LOOKAHEAD_DEPTH = 3;

// Simulate Coily from fromFrame to toFrame, writing into shared table.
// Returns updated Coily state. Reads chase target from waypoints.
function extendCoilyTable(table, cs, waypoints, fromFrame, toFrame, sm, maxFrames) {
    for (var f = fromFrame; f < toFrame && f < maxFrames; f++) {
        var targetR = waypoints[0].row, targetC = waypoints[0].col;
        for (var w = 1; w < waypoints.length; w++) {
            if (waypoints[w].frame <= f) { targetR = waypoints[w].row; targetC = waypoints[w].col; }
            else break;
        }
        if (cs.spawnDrop > 0) { cs.spawnDrop--; continue; }
        if (cs.jumping) {
            cs.jumpT += cs.jumpDur;
            if (cs.jumpT >= 1) {
                cs.jumping = false; cs.row = cs.destRow; cs.col = cs.destCol;
                if (!isValidPos(cs.row, cs.col)) { cs.dead = true; return cs; }
                dangerAdd(table, f, cs.row, cs.col, 1.0, maxFrames);
                cs.idleTimer = ENEMY_IDLE_FRAMES; continue;
            }
            if (cs.jumpT < 0.33) dangerAdd(table, f, cs.row, cs.col, 1.0, maxFrames);
            else if (cs.jumpT >= 0.67 && cs.destRow != null) dangerAdd(table, f, cs.destRow, cs.destCol, 1.0, maxFrames);
            continue;
        }
        if (cs.idleTimer > 0) {
            dangerAdd(table, f, cs.row, cs.col, 1.0, maxFrames);
            cs.idleTimer--; continue;
        }
        cs.moveTimer++;
        if (cs.moveTimer < cs.moveInterval) {
            dangerAdd(table, f, cs.row, cs.col, 1.0, maxFrames);
            continue;
        }
        cs.moveTimer = 0;
        var bestDist = Infinity, bestR = cs.row, bestC = cs.col;
        for (var k = 0; k < 4; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = cs.row + dk.dr, nc = cs.col + dk.dc;
            if (!isValidPos(nr, nc)) continue;
            var dist = Math.abs(targetR - nr) + Math.abs(targetC - nc);
            if (dist < bestDist) { bestDist = dist; bestR = nr; bestC = nc; }
        }
        dangerAdd(table, f, cs.row, cs.col, 1.0, maxFrames);
        cs.destRow = bestR; cs.destCol = bestC;
        cs.jumping = true; cs.jumpT = 0;
        if (!isValidPos(bestR, bestC)) { cs.dead = true; return cs; }
    }
    return cs;
}

function cloneCoilyState(e, sm) {
    return { row: e.row, col: e.col, jumping: !!e.jumping, jumpT: e.jumpT || 0,
             jumpDur: e.jumpDur || ENEMY_JUMP_DUR * sm,
             moveTimer: e.moveTimer || 0,
             moveInterval: e.moveInterval || enemyMoveInterval('coily', sm),
             idleTimer: e.idleTimer || 0, spawnDrop: e.spawnDrop || 0,
             destRow: e.destRow != null ? e.destRow : null,
             destCol: e.destCol != null ? e.destCol : null, dead: false };
}

function saveCoilyState(cs) {
    return [cs.row, cs.col, cs.jumping, cs.jumpT, cs.moveTimer, cs.idleTimer,
            cs.spawnDrop, cs.destRow, cs.destCol, cs.dead];
}

function restoreCoilyState(cs, sn) {
    cs.row=sn[0]; cs.col=sn[1]; cs.jumping=sn[2]; cs.jumpT=sn[3];
    cs.moveTimer=sn[4]; cs.idleTimer=sn[5]; cs.spawnDrop=sn[6];
    cs.destRow=sn[7]; cs.destCol=sn[8]; cs.dead=sn[9];
}

function findMultiHopSurvival(gs, enemyTables, coilyInit, startFrame, maxFrames) {
    var sm = gs.sm;
    var pRow = gs.player.row, pCol = gs.player.col;
    var timeline = new Int8Array(maxFrames);
    for (var i = 0; i < maxFrames; i++) timeline[i] = -1;
    var waypoints = [{ frame: 0, row: pRow, col: pCol }];

    // Coily: simulate incrementally using a simple tile array + state stack.
    // coilyPos[frame] = posIdx at that frame, -1 if immune/absent.
    var coilyPos = coilyInit ? new Int8Array(maxFrames) : null;
    if (coilyPos) for (var cp = 0; cp < maxFrames; cp++) coilyPos[cp] = -1;
    // Coily state for incremental simulation
    var cRow, cCol, cJumping, cJumpT, cJumpDur, cMoveTimer, cMoveInterval;
    var cIdleTimer, cSpawnDrop, cDestRow, cDestCol, cDead;
    if (coilyInit) {
        cRow = coilyInit.row; cCol = coilyInit.col;
        cJumping = !!coilyInit.jumping; cJumpT = coilyInit.jumpT || 0;
        cJumpDur = coilyInit.jumpDur || ENEMY_JUMP_DUR * sm;
        cMoveTimer = coilyInit.moveTimer || 0;
        cMoveInterval = coilyInit.moveInterval || enemyMoveInterval('coily', sm);
        cIdleTimer = coilyInit.idleTimer || 0; cSpawnDrop = coilyInit.spawnDrop || 0;
        cDestRow = coilyInit.destRow != null ? coilyInit.destRow : null;
        cDestCol = coilyInit.destCol != null ? coilyInit.destCol : null;
        cDead = false;
    }

    function coilySave() {
        return [cRow, cCol, cJumping, cJumpT, cMoveTimer, cIdleTimer,
                cSpawnDrop, cDestRow, cDestCol, cDead];
    }
    function coilyRestore(s) {
        cRow=s[0]; cCol=s[1]; cJumping=s[2]; cJumpT=s[3]; cMoveTimer=s[4];
        cIdleTimer=s[5]; cSpawnDrop=s[6]; cDestRow=s[7]; cDestCol=s[8]; cDead=s[9];
    }

    // Simulate Coily from fromFrame to toFrame, filling coilyPos.
    function coilyExtend(fromFrame, toFrame) {
        for (var f = fromFrame; f < toFrame && f < maxFrames && !cDead; f++) {
            var tR = waypoints[0].row, tC = waypoints[0].col;
            for (var w = 1; w < waypoints.length; w++) {
                if (waypoints[w].frame <= f) { tR = waypoints[w].row; tC = waypoints[w].col; }
                else break;
            }
            if (cSpawnDrop > 0) { cSpawnDrop--; continue; }
            if (cJumping) {
                cJumpT += cJumpDur;
                if (cJumpT >= 1) {
                    cJumping = false; cRow = cDestRow; cCol = cDestCol;
                    if (!isValidPos(cRow, cCol)) { cDead = true; return; }
                    coilyPos[f] = posToIdx[cRow * ROWS + cCol];
                    cIdleTimer = ENEMY_IDLE_FRAMES; continue;
                }
                if (cJumpT < 0.33) coilyPos[f] = posToIdx[cRow * ROWS + cCol];
                else if (cJumpT >= 0.67 && cDestRow != null) coilyPos[f] = posToIdx[cDestRow * ROWS + cDestCol];
                continue;
            }
            if (cIdleTimer > 0) { coilyPos[f] = posToIdx[cRow * ROWS + cCol]; cIdleTimer--; continue; }
            cMoveTimer++;
            if (cMoveTimer < cMoveInterval) { coilyPos[f] = posToIdx[cRow * ROWS + cCol]; continue; }
            cMoveTimer = 0;
            var bD = Infinity, bR = cRow, bC = cCol;
            for (var k = 0; k < 4; k++) {
                var dk = DIRS[DIR_KEYS[k]];
                var nr = cRow + dk.dr, nc = cCol + dk.dc;
                if (!isValidPos(nr, nc)) continue;
                var d = Math.abs(tR - nr) + Math.abs(tC - nc);
                if (d < bD) { bD = d; bR = nr; bC = nc; }
            }
            coilyPos[f] = posToIdx[cRow * ROWS + cCol];
            cDestRow = bR; cDestCol = bC; cJumping = true; cJumpT = 0;
            if (!isValidPos(bR, bC)) { cDead = true; return; }
        }
    }

    // Check player vs Coily for a frame range.
    function coilyCheck(fromFrame, toFrame) {
        for (var f = fromFrame; f < toFrame; f++) {
            if (timeline[f] >= 0 && coilyPos[f] === timeline[f]) return false;
        }
        return true;
    }

    function search(curRow, curCol, depth, curFrame, accumSurv) {
        if (accumSurv <= 0) return 0;
        if (depth >= LOOKAHEAD_DEPTH || curFrame >= maxFrames) {
            var curIdx = posToIdx[curRow * ROWS + curCol];
            var extEnd = Math.min(curFrame + 40, maxFrames);
            for (var ef = curFrame; ef < extEnd; ef++) timeline[ef] = curIdx;
            var leafSurv = accumSurv;
            for (var t = 0; t < enemyTables.length; t++) {
                leafSurv *= tableSurvivalProb(timeline, enemyTables[t], curFrame, extEnd);
                if (leafSurv <= 0) break;
            }
            if (leafSurv > 0 && coilyPos && !cDead) {
                var cSnap = coilySave();
                coilyExtend(curFrame, extEnd);
                if (!coilyCheck(startFrame, extEnd)) leafSurv = 0;
                coilyRestore(cSnap);
                for (var cf = curFrame; cf < extEnd; cf++) coilyPos[cf] = -1;
            }
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

            var newSurv = accumSurv;
            for (var t = 0; t < enemyTables.length; t++) {
                newSurv *= tableSurvivalProb(timeline, enemyTables[t], curFrame, hop.endFrame);
                if (newSurv <= 0) break;
            }

            // Coily: extend incrementally, check only new frames
            var coilyOk = true;
            if (newSurv > 0 && coilyPos && !cDead) {
                var cSnap = coilySave();
                coilyExtend(curFrame, hop.endFrame);
                if (!coilyCheck(curFrame, hop.endFrame)) { coilyOk = false; newSurv = 0; }

                if (newSurv > 0) {
                    var s = search(hop.endRow, hop.endCol, depth + 1, hop.endFrame, newSurv);
                    if (s > best) best = s;
                }

                coilyRestore(cSnap);
                for (var cf = curFrame; cf < hop.endFrame && cf < maxFrames; cf++) coilyPos[cf] = -1;
            } else if (newSurv > 0) {
                var s = search(hop.endRow, hop.endCol, depth + 1, hop.endFrame, newSurv);
                if (s > best) best = s;
            }

            if (hop.landFrame >= 0) waypoints.pop();
            for (var f = curFrame; f < hop.endFrame && f < maxFrames; f++) timeline[f] = -1;
            if (best >= 0.99) break;
        }
        return best;
    }

    var bestPerDir = {};
    for (var dk = 0; dk < DIR_KEYS_WITH_STAY.length; dk++) {
        var dir1 = DIR_KEYS_WITH_STAY[dk];
        if (!simCanMove(gs, dir1)) continue;

        var hop1 = appendHop(timeline, pRow, pCol, dir1, gs.sm, 0, maxFrames);
        if (!hop1) continue;
        if (hop1.landFrame >= 0)
            waypoints.push({ frame: hop1.landFrame, row: hop1.endRow, col: hop1.endCol });

        // Reset Coily state for each dir1
        if (coilyInit) {
            cRow = coilyInit.row; cCol = coilyInit.col;
            cJumping = !!coilyInit.jumping; cJumpT = coilyInit.jumpT || 0;
            cMoveTimer = coilyInit.moveTimer || 0; cIdleTimer = coilyInit.idleTimer || 0;
            cSpawnDrop = coilyInit.spawnDrop || 0;
            cDestRow = coilyInit.destRow != null ? coilyInit.destRow : null;
            cDestCol = coilyInit.destCol != null ? coilyInit.destCol : null;
            cDead = false;
        }

        var hop1Surv = 1.0;
        for (var t = 0; t < enemyTables.length; t++) {
            hop1Surv *= tableSurvivalProb(timeline, enemyTables[t], startFrame, hop1.endFrame);
            if (hop1Surv <= 0) break;
        }
        if (hop1Surv > 0 && coilyPos) {
            coilyExtend(startFrame, hop1.endFrame);
            if (!coilyCheck(startFrame, hop1.endFrame)) hop1Surv = 0;
        }

        if (hop1Surv > 0) {
            bestPerDir[dir1] = search(hop1.endRow, hop1.endCol, 1, hop1.endFrame, hop1Surv);
        } else {
            bestPerDir[dir1] = 0;
        }

        if (hop1.landFrame >= 0) waypoints.pop();
        for (var f = 0; f < hop1.endFrame && f < maxFrames; f++) timeline[f] = -1;
        // Clear Coily positions for this dir1
        if (coilyPos) for (var cf = startFrame; cf < hop1.endFrame && cf < maxFrames; cf++) coilyPos[cf] = -1;
    }
    return bestPerDir;
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
    var baseSeed = (gs.player.row * 7 + gs.player.col) * 10000 + (frameCount || 0);
    function simSeed(sampleIdx) { simRng = createSeededRng(baseSeed + sampleIdx * 9973); }
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

    // ── Compute 5-hop survival per direction via danger tables ──
    var hop1Surv = {};

    if (!hasEnemies) {
        for (var k = 0; k < DIR_KEYS_WITH_STAY.length; k++) {
            var dir = DIR_KEYS_WITH_STAY[k];
            if (simCanMove(gs, dir)) { hop1Surv[dir] = 1.0; aiMoveScores[dir] = 10000; }
        }
    } else {
        var maxFrames = DANGER_MAX_FRAMES;
        var startFrame = Math.min(gs.freezeTimer || 0, maxFrames);
        var enemyTables = [];
        var coilyInit = null;

        for (var ei = 0; ei < gs.enemies.length; ei++) {
            var e = gs.enemies[ei];
            if (e.type === 'spawn-timer') {
                if (e.timer <= maxFrames) {
                    var ft = e.forcedType;
                    if (!ft) {
                        var hasCoilyOrEgg2 = false;
                        for (var ci3 = 0; ci3 < gs.enemies.length; ci3++)
                            if (gs.enemies[ci3].type === 'coily' || gs.enemies[ci3].type === 'egg') { hasCoilyOrEgg2 = true; break; }
                        ft = hasCoilyOrEgg2 ? 'redball' : 'egg';
                    }
                    var spTables = buildSpawnDangerTable(ft, e.timer, gs.sm, maxFrames);
                    for (var sti = 0; sti < spTables.length; sti++) enemyTables.push(spTables[sti]);
                }
                continue;
            }
            if (e.type === 'slick' || e.type === 'sam' || e.type === 'greenball') continue;
            if (e.type === 'coily') { coilyInit = e; continue; }
            enemyTables.push(buildEnemyDangerTable(e, gs.sm, maxFrames));
        }

        var multiHop = findMultiHopSurvival(gs, enemyTables, coilyInit, startFrame, maxFrames);
        for (var mdir in multiHop) {
            hop1Surv[mdir] = multiHop[mdir];
            aiMoveScores[mdir] = Math.round(multiHop[mdir] * 10000);
        }
    }

    // ── Opportunistic disc usage to kill Coily ──
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

            if (gs.player.row === trigRow && gs.player.col === trigCol) {
                var discDir = disc.side === 0 ? 'UL' : 'UR';
                console.log('DISC-KILL @(' + gs.player.row + ',' + gs.player.col + ') → ' + discDir);
                restoreRng(); return discDir;
            }

            for (var dk = 0; dk < shuffledDirs.length; dk++) {
                var ddir = shuffledDirs[dk];
                var dd = DIRS[ddir];
                var dr = gs.player.row + dd.dr, dc = gs.player.col + dd.dc;
                if (dr !== trigRow || dc !== trigCol) continue;
                if ((hop1Surv[ddir] || 0) < 1.0) continue;
                console.log('DISC-APPROACH @(' + gs.player.row + ',' + gs.player.col + ') → ' + ddir + ' → disc');
                restoreRng(); return ddir;
            }
        }
    }

    // ── Direction selection: guaranteed-safe with best routing ──
    var targetDist = peelTargetDist(gs);

    // Pass 1: among directions with P=1.0, pick best routing
    var bestDir = null, bestScore = Infinity;
    var _routeDbg = [];
    for (var fk = 0; fk < shuffledDirs.length; fk++) {
        var fd = shuffledDirs[fk];
        var fdd = DIRS[fd];
        var lr = gs.player.row + fdd.dr, lc = gs.player.col + fdd.dc;
        if (!isValidPos(lr, lc)) continue;
        var lidx = posToIdx[lr * ROWS + lc];
        var surv = hop1Surv[fd] || 0;
        if (surv < 1.0) { _routeDbg.push(fd + '→(' + lr + ',' + lc + ') P=' + surv.toFixed(2)); continue; }
        if (lidx < 0) continue;

        var score = targetDist[lidx];
        _routeDbg.push(fd + '→(' + lr + ',' + lc + ') dist=' + score.toFixed(1) + ' P=1 L=' + STATIC_PEEL.layer[lidx]);
        if (score >= 999) continue;
        score -= posAdj[lidx].length * 0.01;
        if (score < bestScore) { bestScore = score; bestDir = fd; }
    }
    if (bestDir) {
        console.log('ROUTE @(' + gs.player.row + ',' + gs.player.col + ') → ' + bestDir + ' | ' + _routeDbg.join(' | '));
        restoreRng(); return bestDir;
    }

    // Pass 1b: toggle-level fallback BFS
    if (gs.lv >= 3) {
        targetDist = peelTargetDist(gs, true);
        bestDir = null; bestScore = Infinity;
        for (var fk2 = 0; fk2 < shuffledDirs.length; fk2++) {
            var fd2 = shuffledDirs[fk2];
            var fdd2 = DIRS[fd2];
            var lr2 = gs.player.row + fdd2.dr, lc2 = gs.player.col + fdd2.dc;
            if (!isValidPos(lr2, lc2)) continue;
            if ((hop1Surv[fd2] || 0) < 1.0) continue;
            var lidx2 = posToIdx[lr2 * ROWS + lc2];
            if (lidx2 < 0) continue;
            var score2 = targetDist[lidx2];
            if (score2 >= 999) continue;
            score2 -= posAdj[lidx2].length * 0.01;
            if (score2 < bestScore) { bestScore = score2; bestDir = fd2; }
        }
        if (bestDir) {
            console.log('ROUTE-FALLBACK @(' + gs.player.row + ',' + gs.player.col + ') → ' + bestDir);
            restoreRng(); return bestDir;
        }
    }

    // Pass 2: no guaranteed-safe direction — pick highest survival, tiebreak by routing
    console.log('NO-SAFE @(' + gs.player.row + ',' + gs.player.col + ') | ' + _routeDbg.join(' | '));
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
