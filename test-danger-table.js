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

console.log('\n' + tests + ' tests, ' + totalErrors + ' errors');
if (totalErrors === 0) console.log('ALL PASS — danger table matches main game engine');
else console.log('MISMATCHES found — need to fix danger table');
