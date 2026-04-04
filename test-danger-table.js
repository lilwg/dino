#!/usr/bin/env node
// Verify danger table matches game engine frame-by-frame.
// Runs both the actual simUpdateEnemies and the danger table expansion
// on identical enemy states, compares collision tile at each frame.

// Load game engine
var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));

// ─── Danger table expansion (copy from qbert-ai.js, to be kept in sync) ────

function dangerMark(table, frame, row, col, prob, maxFrames) {
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

function expandEnemyPaths(table, type, row, col, jumping, jumpT, jumpDur,
                          moveTimer, moveInterval, hops, falling, willHatch,
                          spawnDrop, destRow, destCol, idleTimer,
                          frame, maxFrames, sm, prob) {
    if (frame >= maxFrames) return;
    if (falling) {
        if (jumping) {
            var newJT = jumpT + jumpDur;
            if (newJT < 0.33) {
                dangerMark(table, frame, row, col, prob, maxFrames);
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
                dangerMark(table, frame, landRow, landCol, prob, maxFrames);
                for (var ef = 1; ef <= 10; ef++)
                    dangerMark(table, frame + ef, landRow, landCol, prob, maxFrames);
                return;
            }
            dangerMark(table, frame, landRow, landCol, prob, maxFrames);
            expandEnemyPaths(table, newType, landRow, landCol, false, 0, jumpDur,
                0, newInterval, hops, false, newWillHatch,
                0, null, null, ENEMY_IDLE_FRAMES, frame + 1, maxFrames, sm, prob);
        } else {
            if (newJumpT < 0.33) dangerMark(table, frame, row, col, prob, maxFrames);
            else if (newJumpT >= 0.67) {
                if (destRow != null) dangerMark(table, frame, destRow, destCol, prob, maxFrames);
            }
            expandEnemyPaths(table, type, row, col, true, newJumpT, jumpDur,
                moveTimer, moveInterval, hops, falling, willHatch,
                0, destRow, destCol, idleTimer, frame + 1, maxFrames, sm, prob);
        }
        return;
    }
    if (idleTimer > 0) {
        dangerMark(table, frame, row, col, prob, maxFrames);
        expandEnemyPaths(table, type, row, col, false, 0, jumpDur,
            moveTimer, moveInterval, hops, false, willHatch,
            0, null, null, idleTimer - 1, frame + 1, maxFrames, sm, prob);
        return;
    }
    var newMoveTimer = moveTimer + 1;
    if (newMoveTimer < moveInterval) {
        dangerMark(table, frame, row, col, prob, maxFrames);
        expandEnemyPaths(table, type, row, col, false, 0, jumpDur,
            newMoveTimer, moveInterval, hops, false, willHatch,
            0, null, null, 0, frame + 1, maxFrames, sm, prob);
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
            0, nr, nc, 0, frame + 1, maxFrames, sm, branchProb);
    }
}

// ─── Test: run game engine for one enemy, compare collision tiles per frame ──

function testEnemy(type, startRow, startCol, sm, randomChoices) {
    var maxFrames = 100;
    var jumpDur = ENEMY_JUMP_DUR * sm;
    var interval = enemyMoveInterval(type, sm);

    // Build danger table
    var table = new Float32Array(maxFrames * POS_COUNT);
    expandEnemyPaths(table, type, startRow, startCol, false, 0, jumpDur,
        0, interval, 0, false, false, 0, null, null, 0,
        0, maxFrames, sm, 1.0);

    // Run game engine with forced random choices
    var choiceIdx = 0;
    simRng = function() { return randomChoices[choiceIdx++ % randomChoices.length]; };

    // Create minimal game state
    var gs = {
        player: { row: 0, col: 0, jumping: false, jumpT: 0, jumpDur: PLAYER_JUMP_DUR * sm,
                  dead: false, deathTimer: 0, destRow: null, destCol: null, idleTimer: 0 },
        enemies: [{ type: type, row: startRow, col: startCol, jumping: false, jumpT: 0,
                    jumpDur: jumpDur, destRow: null, destCol: null,
                    moveTimer: 0, moveInterval: interval, falling: false, willHatch: false,
                    hops: 0, spawnDrop: 0, idleTimer: 0 }],
        cubes: [], discs: [], sm: sm, tgt: 1, lv: 1, cubesColored: 0,
        score: 0, alive: true, freezeTimer: 0, round: 1, levelWon: false
    };

    var errors = 0;
    for (var f = 0; f < maxFrames; f++) {
        if (gs.enemies.length === 0) break; // enemy fell off

        var e = gs.enemies[0];
        if (e.type === 'spawn-timer') break;

        // Get collision tile from game engine BEFORE update (same as collisionTile check)
        // Actually no — simCheckCollision runs AFTER simUpdateEnemies.
        // So we need to update first, then check.
        simUpdateEnemies(gs);
        if (gs.enemies.length === 0) break;
        e = gs.enemies[0];
        if (!e || e.type === 'spawn-timer') break;

        var et = collisionTile(e);

        // Check danger table at this frame
        if (et) {
            var idx = posToIdx[et.row * ROWS + et.col];
            if (idx >= 0) {
                var prob = table[f * POS_COUNT + idx];
                if (prob <= 0) {
                    console.log('MISMATCH f=' + f + ': game says ' + type + ' at (' + et.row + ',' + et.col +
                        ') idx=' + idx + ' but table has P=0 there');
                    // Show what table has at this frame
                    var found = [];
                    for (var p = 0; p < POS_COUNT; p++) {
                        if (table[f * POS_COUNT + p] > 0)
                            found.push('(' + idxToPos[p][0] + ',' + idxToPos[p][1] + ')=' + table[f * POS_COUNT + p].toFixed(3));
                    }
                    console.log('  Table f=' + f + ': ' + (found.length > 0 ? found.join(' ') : 'EMPTY'));
                    console.log('  Enemy state: jumping=' + e.jumping + ' jumpT=' + (e.jumpT||0).toFixed(3) +
                        ' mt=' + e.moveTimer + '/' + e.moveInterval + ' idle=' + (e.idleTimer||0) +
                        ' hops=' + (e.hops||0) + ' row=' + e.row + ' col=' + e.col);
                    errors++;
                }
            }
        } else {
            // Enemy is immune — check table doesn't have anything here
            // (table might have probability at immune frames for OTHER paths, that's OK)
        }
    }
    return errors;
}

// ─── Run tests ──────────────────────────────────────────────────────────────

var totalErrors = 0;
var tests = 0;

// Test each enemy type with various random choice sequences
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
        // Test with all-left, all-right, and alternating choices
        var choiceSets = [[0.1], [0.9], [0.1, 0.9], [0.9, 0.1, 0.1, 0.9]];
        for (var ci = 0; ci < choiceSets.length; ci++) {
            tests++;
            var errs = testEnemy(type, starts[si][0], starts[si][1], 1.0, choiceSets[ci]);
            totalErrors += errs;
            if (errs > 0) {
                console.log('FAIL: ' + type + ' @(' + starts[si][0] + ',' + starts[si][1] +
                    ') choices=[' + choiceSets[ci] + ']: ' + errs + ' mismatches');
            }
        }
    }
}

// Test with different speed multipliers
for (var sm = 1.0; sm <= 2.0; sm += 0.2) {
    tests++;
    var errs = testEnemy('redball', 1, 0, sm, [0.1]);
    totalErrors += errs;
    if (errs > 0) console.log('FAIL: redball sm=' + sm.toFixed(1) + ': ' + errs + ' mismatches');
}

console.log('\n' + tests + ' tests, ' + totalErrors + ' total errors');
if (totalErrors === 0) console.log('ALL TESTS PASS — danger table matches game engine exactly');
else console.log('DANGER TABLE HAS MISMATCHES — must fix before proceeding');
