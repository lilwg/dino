#!/usr/bin/env node
// Verify danger table matches main's game engine frame-by-frame.
// Main uses different timing (no idle frames) and deterministic Coily.

var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));

// ─── Danger table (adapted for main's timing: no idle frames) ───────────────

function dangerMark(table, frame, row, col, prob, maxFrames) {
    if (frame >= maxFrames) return;
    var idx = posToIdx[row * ROWS + col];
    if (idx >= 0) table[frame * POS_COUNT + idx] += prob;
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

// Recursively expand enemy paths (binary branching on random moves).
// Adapted for main's timing: no idle frames after landing.
function expandEnemyPaths(table, type, row, col, jumping, jumpT, jumpDur,
                          moveTimer, moveInterval, hops, falling, willHatch,
                          spawnAnimTimer, destRow, destCol,
                          frame, maxFrames, sm, prob) {
    if (frame >= maxFrames) return;
    if (falling) {
        if (jumping) {
            var newJT = jumpT + jumpDur;
            if (newJT < 0.33) {
                dangerMark(table, frame, row, col, prob, maxFrames);
                expandEnemyPaths(table, type, row, col, true, newJT, jumpDur,
                    moveTimer, moveInterval, hops, true, willHatch,
                    0, destRow, destCol, frame + 1, maxFrames, sm, prob);
            } else if (newJT < 0.67) {
                expandEnemyPaths(table, type, row, col, true, newJT, jumpDur,
                    moveTimer, moveInterval, hops, true, willHatch,
                    0, destRow, destCol, frame + 1, maxFrames, sm, prob);
            }
        }
        return;
    }
    if (spawnAnimTimer > 0) {
        expandEnemyPaths(table, type, row, col, jumping, jumpT, jumpDur,
            moveTimer, moveInterval, hops, falling, willHatch,
            spawnAnimTimer - 1, destRow, destCol, frame + 1, maxFrames, sm, prob);
        return;
    }
    if (jumping) {
        var newJumpT = jumpT + jumpDur;
        if (newJumpT >= 1) {
            var landRow = destRow, landCol = destCol;
            if (!isValidPos(landRow, landCol)) return;
            var newType = type, newInterval = moveInterval;
            if (type === 'egg' && (hops >= 6 || landRow >= ROWS - 1 || willHatch)) {
                // egg hatches into coily at landing — mark and stop
                // (coily is deterministic, player-dependent, handled separately)
                dangerMark(table, frame, landRow, landCol, prob, maxFrames);
                return;
            }
            dangerMark(table, frame, landRow, landCol, prob, maxFrames);
            // Main: no idle, go directly to moveTimer ticking
            expandEnemyPaths(table, newType, landRow, landCol, false, 0, jumpDur,
                0, newInterval, hops, false, false,
                0, null, null, frame + 1, maxFrames, sm, prob);
        } else {
            if (newJumpT < 0.33) dangerMark(table, frame, row, col, prob, maxFrames);
            else if (newJumpT >= 0.67) {
                if (destRow != null) dangerMark(table, frame, destRow, destCol, prob, maxFrames);
            }
            expandEnemyPaths(table, type, row, col, true, newJumpT, jumpDur,
                moveTimer, moveInterval, hops, falling, willHatch,
                0, destRow, destCol, frame + 1, maxFrames, sm, prob);
        }
        return;
    }
    var newMoveTimer = moveTimer + 1;
    if (newMoveTimer < moveInterval) {
        dangerMark(table, frame, row, col, prob, maxFrames);
        expandEnemyPaths(table, type, row, col, false, 0, jumpDur,
            newMoveTimer, moveInterval, hops, false, willHatch,
            0, null, null, frame + 1, maxFrames, sm, prob);
        return;
    }
    var choices = getMoveChoicesForType(type, row, col);
    dangerMark(table, frame, row, col, prob, maxFrames);
    var branchProb = choices.length > 0 ? prob / choices.length : prob;
    for (var ci = 0; ci < choices.length; ci++) {
        var nr = choices[ci][0], nc = choices[ci][1];
        var newFalling = !isValidPos(nr, nc);
        var newHops = hops + 1;
        var newWH = false;
        if (type === 'egg' && (newHops >= 6 || nr >= ROWS - 1)) newWH = true;
        expandEnemyPaths(table, type, row, col, true, 0, jumpDur,
            0, moveInterval, newHops, newFalling, newWH,
            0, nr, nc, frame + 1, maxFrames, sm, branchProb);
    }
}

// ─── Test: run game engine for one enemy, compare with danger table ──────────

function testEnemy(type, startRow, startCol, sm, randomChoices) {
    var maxFrames = 200;
    var jumpDur = ENEMY_JUMP_DUR * sm;
    var interval = enemyMoveInterval(type, sm);

    var table = new Float32Array(maxFrames * POS_COUNT);
    expandEnemyPaths(table, type, startRow, startCol, false, 0, jumpDur,
        0, interval, 0, false, false, 0, null, null,
        0, maxFrames, sm, 1.0);

    // Run game engine with forced choices
    var choiceQ = randomChoices.slice();
    // Main uses simHopDecisionQ for forced choices
    if (typeof simHopDecisionQ !== 'undefined') {
        simHopDecisionQ = choiceQ.map(function(c) { return c > 0.5 ? 1 : 0; });
        simHopDecisionIdx = 0;
    }

    var gs = {
        player: { row: 0, col: 0, jumping: false, jumpT: 0, jumpDur: PLAYER_JUMP_DUR * sm,
                  dead: false, deathTimer: 0, destRow: null, destCol: null,
                  prevRow: 0, prevCol: 0 },
        enemies: [{ type: type, row: startRow, col: startCol, jumping: false, jumpT: 0,
                    jumpDur: jumpDur, destRow: null, destCol: null, jumpSrcRow: null, jumpSrcCol: null,
                    moveTimer: 0, moveInterval: interval, falling: false, willHatch: false,
                    hops: 0, spawnAnimTimer: 0, dirBits: null, lureRow: null, lureCol: null }],
        cubes: [], discs: [], sm: sm, tgt: 1, lv: 1, cubesColored: 0,
        score: 0, alive: true, freezeTimer: 0, round: 1, levelWon: false
    };

    var errors = 0;
    for (var f = 0; f < maxFrames; f++) {
        if (gs.enemies.length === 0) break;
        var e = gs.enemies[0];
        if (!e || e.type === 'spawn-timer') break;
        simUpdateEnemies(gs);
        if (gs.enemies.length === 0) break;
        e = gs.enemies[0];
        if (!e || e.type === 'spawn-timer') break;
        if (e.falling) continue;

        var et = collisionTile(e);
        if (et) {
            var idx = posToIdx[et.row * ROWS + et.col];
            if (idx >= 0) {
                var prob = table[f * POS_COUNT + idx];
                if (prob <= 0) {
                    console.log('MISMATCH f=' + f + ': game=' + type + '@(' + et.row + ',' + et.col +
                        ') jmp=' + e.jumping + ' jT=' + (e.jumpT||0).toFixed(3) +
                        ' mt=' + e.moveTimer + '/' + e.moveInterval +
                        ' — table has P=0 here');
                    errors++;
                }
            }
        }
    }
    return errors;
}

// ─── Coily test: deterministic ROM grid-word algorithm ──────────────────────

// Build Coily danger table using main's ROM algorithm.
// Coily chases player's PREVIOUS position (or CURRENT if Coily is at prev).
// targetTimeline[frame] = {row, col} for Coily's chase target at that frame.
function buildCoilyTable(e, targetTimeline, sm, maxFrames) {
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
                jumping = false;
                row = destRow; col = destCol;
                if (!isValidPos(row, col)) break;
                dangerMark(table, f, row, col, 1.0, maxFrames);
                continue;
            }
            if (jumpT < 0.33) dangerMark(table, f, row, col, 1.0, maxFrames);
            else if (jumpT >= 0.67 && destRow != null) dangerMark(table, f, destRow, destCol, 1.0, maxFrames);
            continue;
        }

        moveTimer++;
        if (moveTimer < interval) {
            dangerMark(table, f, row, col, 1.0, maxFrames);
            continue;
        }
        moveTimer = 0;

        // ROM grid-word chase: target = prev, except if Coily AT prev → cur
        var tgt = targetTimeline[f] || targetTimeline[0];
        var targetR, targetC;
        if (tgt.prev) {
            if (row === tgt.prev.row && col === tgt.prev.col) {
                targetR = tgt.cur.row; targetC = tgt.cur.col;
            } else {
                targetR = tgt.prev.row; targetC = tgt.prev.col;
            }
        } else {
            targetR = tgt.row; targetC = tgt.col;
        }
        // Exception: if Coily IS at prev, chase current
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

        dangerMark(table, f, row, col, 1.0, maxFrames);
        destRow = enr; destCol = enc; jumping = true; jumpT = 0;
        if (!isValidPos(enr, enc)) break;
    }
    return table;
}

function testCoily(coilyStart, playerPath, sm) {
    var maxFrames = 200;
    var jumpDur = ENEMY_JUMP_DUR * sm;
    var interval = enemyMoveInterval('coily', sm);

    // Run game engine with a fixed player that follows playerPath
    var gs = {
        player: { row: playerPath[0].row, col: playerPath[0].col,
                  jumping: false, jumpT: 0, jumpDur: PLAYER_JUMP_DUR * sm,
                  dead: false, deathTimer: 0, destRow: null, destCol: null,
                  prevRow: playerPath[0].row, prevCol: playerPath[0].col },
        enemies: [{ type: 'coily', row: coilyStart.row, col: coilyStart.col,
                    jumping: false, jumpT: 0, jumpDur: jumpDur,
                    destRow: null, destCol: null, jumpSrcRow: null, jumpSrcCol: null,
                    moveTimer: 0, moveInterval: interval, falling: false, willHatch: false,
                    hops: 0, spawnAnimTimer: 0, dirBits: null, lureRow: null, lureCol: null }],
        cubes: [], discs: [], sm: sm, tgt: 1, lv: 1, cubesColored: 0,
        score: 0, alive: true, freezeTimer: 0, round: 1, levelWon: false
    };

    // Build target timeline (Coily chases player's prev position)
    var targetTimeline = [];
    for (var f = 0; f < maxFrames; f++) {
        var pi = Math.min(f, playerPath.length - 1);
        targetTimeline[f] = { row: playerPath[pi].prevRow, col: playerPath[pi].prevCol };
    }

    var table = buildCoilyTable(gs.enemies[0], targetTimeline, sm, maxFrames);

    var errors = 0;
    for (var f = 0; f < maxFrames; f++) {
        if (gs.enemies.length === 0) break;
        // Update player position at this frame
        var pi = Math.min(f, playerPath.length - 1);
        gs.player.row = playerPath[pi].row; gs.player.col = playerPath[pi].col;
        gs.player.prevRow = playerPath[pi].prevRow; gs.player.prevCol = playerPath[pi].prevCol;

        simUpdateEnemies(gs);
        if (gs.enemies.length === 0 || gs.enemies[0].falling) break;
        var e = gs.enemies[0];
        var et = collisionTile(e);
        if (et) {
            var idx = posToIdx[et.row * ROWS + et.col];
            if (idx >= 0 && table[f * POS_COUNT + idx] <= 0) {
                console.log('COILY MISMATCH f=' + f + ': game=(' + et.row + ',' + et.col +
                    ') jmp=' + e.jumping + ' jT=' + (e.jumpT||0).toFixed(3));
                errors++;
            }
        }
    }
    return errors;
}

// Test Coily chasing stationary player
var playerStatic = [];
for (var f = 0; f < 200; f++) playerStatic.push({row: 3, col: 2, prevRow: 3, prevCol: 2});

var totalErrors = 0, tests = 0;
var types = ['redball', 'egg', 'ugg', 'wrongway'];
var startPositions = {
    redball: [[1, 0], [1, 1]],
    egg: [[1, 0], [1, 1]],
    ugg: [[6, 6]],
    wrongway: [[6, 0]]
};

for (var ti = 0; ti < types.length; ti++) {
    var type = types[ti];
    var starts = startPositions[type];
    for (var si = 0; si < starts.length; si++) {
        var choiceSets = [[0.1], [0.9], [0.1, 0.9], [0.9, 0.1, 0.1, 0.9, 0.1, 0.9]];
        for (var ci = 0; ci < choiceSets.length; ci++) {
            tests++;
            var errs = testEnemy(type, starts[si][0], starts[si][1], 1.0, choiceSets[ci]);
            totalErrors += errs;
            if (errs > 0) console.log('FAIL ' + type + '@(' + starts[si] + ') choices=[' + choiceSets[ci] + '] errors=' + errs);
        }
    }
}

// Coily tests: various starting positions chasing stationary player
var coilyStarts = [{row:5,col:0},{row:5,col:2},{row:5,col:5},{row:6,col:3},{row:4,col:2},{row:2,col:1}];
for (var ci = 0; ci < coilyStarts.length; ci++) {
    tests++;
    var errs = testCoily(coilyStarts[ci], playerStatic, 1.0);
    totalErrors += errs;
    if (errs > 0) console.log('FAIL coily@(' + coilyStarts[ci].row + ',' + coilyStarts[ci].col + ') errors=' + errs);
}

console.log('\n' + tests + ' tests, ' + totalErrors + ' errors');
if (totalErrors === 0) console.log('ALL PASS — danger table matches main game engine');
else console.log('MISMATCHES found — need to fix danger table');
