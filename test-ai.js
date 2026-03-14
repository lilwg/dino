#!/usr/bin/env node
// Q*bert AI test harness — frame-based simulation (matches HTML game)
// Loads shared AI from qbert-ai.js, adds game simulation on top.

// ─── Load shared AI module ───────────────────────────────────────────────────
var player, enemies, cubeStates, discs, round, score;
var aiTour, aiTourIdx, aiBoardSig, aiDetailPath, aiTourDots;
var astarStats = { solved: 0, fallbacks: 0, totalNodes: 0, cacheHits: 0 };
eval(require('fs').readFileSync(__dirname + '/qbert-ai.js', 'utf8'));

// ─── Frame-based timing constants (match HTML game exactly) ─────────────────
// These are the same BASE_ENEMY_INTERVALS from dino-qbert.html
var BASE_ENEMY_INTERVALS = {
    egg:        4,   // 4 idle frames between hops
    coily:      4,
    redball:    4,
    greenball: 12,
    slick:     20,
    ugg:        4,
    wrongway:   4
};

var PLAYER_JUMP_DUR = 0.028;  // jumpT increment per frame (player)
var ENEMY_JUMP_DUR  = 0.030;  // jumpT increment per frame (enemy)

function enemyMoveInterval(type) {
    return Math.round((BASE_ENEMY_INTERVALS[type] || 30) / speedMultiplier());
}

var lives, extraLifeGiven, levelWon, turnCount, freezeTimer;
var frameCount;

// ─── exCloneState (frame-accurate: computes commitFrame per enemy) ───────────
function exCloneState() {
    var tgt = targetState();
    var cs = new Array(cubeStates.length);
    for (var i = 0; i < cubeStates.length; i++)
        cs[i] = { row: cubeStates[i].row, col: cubeStates[i].col, state: cubeStates[i].state };
    var ens = [];
    var lethalRandom = [];
    var sm = speedMultiplier();
    var jumpDur = ENEMY_JUMP_DUR * sm;
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;
        // Compute commitFrame: frames until enemy commits to NEXT position.
        // This is the key for frame-accurate collision detection.
        var cf;
        if (e.jumping) {
            if (e.jumpT < 0.5) {
                // Pre-apex: will commit current jump destination soon
                // But effective pos already points there, so "next commit"
                // is the FOLLOWING hop: finish this jump + idle + next apex
                cf = Math.ceil((1.0 - e.jumpT) / jumpDur)
                   + exEnemyIdle(e.type, sm) + exEnemyApex(sm);
            } else {
                // Post-apex: position already committed. Next commit is:
                // finish this jump + idle + next apex
                cf = Math.ceil((1.0 - e.jumpT) / jumpDur)
                   + exEnemyIdle(e.type, sm) + exEnemyApex(sm);
            }
        } else {
            // Idle: frames until jump starts + frames to apex
            var mi = e.moveInterval || exEnemyIdle(e.type, sm);
            var mt = e.moveTimer || 0;
            cf = (mi - mt) + exEnemyApex(sm);
        }
        // Use effective position (destination if mid-jump pre-apex)
        var pos = enemyEffectivePos(e);
        var er = pos.row, ec = pos.col;
        if (e.type === 'coily') {
            ens.push({ type: e.type, row: er, col: ec, hops: e.hops || 0,
                       commitFrame: cf, accum: cf / exPlayerHop(sm) });
        } else if (e.type === 'slick' || e.type === 'greenball') {
            continue; // safe enemies — skip
        } else {
            var d = exBfsDist(player.row, player.col, er, ec);
            lethalRandom.push({ e: e, dist: d, cf: cf, er: er, ec: ec });
        }
    }
    lethalRandom.sort(function(a, b) { return a.dist - b.dist; });
    for (var i = 0; i < Math.min(5, lethalRandom.length); i++) {
        var lr = lethalRandom[i];
        ens.push({ type: lr.e.type, row: lr.er, col: lr.ec,
                   hops: lr.e.hops || 0,
                   commitFrame: lr.cf, accum: lr.cf / exPlayerHop(sm),
                   cloud: [{ row: lr.er, col: lr.ec, prob: 1.0 }] });
    }
    var colored = 0;
    for (var i = 0; i < cs.length; i++) colored += Math.min(cs[i].state, tgt);
    var ds = [];
    for (var i = 0; i < discs.length; i++)
        ds.push({ side: discs[i].side, row: discs[i].row, active: discs[i].active });
    // Include imminent spawn timers
    var framesPerHop = exPlayerHop(sm);
    var spawns = [];
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') {
            var stepsUntil = Math.ceil(e.timer / framesPerHop);
            if (stepsUntil <= 3) {
                spawns.push({ timer: stepsUntil, forcedType: e.forcedType || null });
            }
        }
    }
    return { pr: player.row, pc: player.col, cubes: cs, enemies: ens,
             alive: true, score: 0, cubesColored: colored, tgt: tgt,
             discs: ds, lv: arcadeLevel(), spawns: spawns, sm: sm };
}

// Override AI time budget — node can afford deeper search than a 16ms frame
AI_TIME_BUDGET = 50;

// ─── computeAIMove (test-specific: no visualization) ─────────────────────────
function computeAIMove() {
    var bestDir = aiPickBestDir();
    if (boardSig() !== aiBoardSig || aiTour.length === 0) buildTour();
    return bestDir;
}

// ─── Game simulation (frame-based, matching HTML) ───────────────────────────
function checkExtraLife() {
    var nextThreshold = extraLifeGiven ? (8000 + extraLifeGiven * 14000) : 8000;
    if (score >= nextThreshold) {
        extraLifeGiven = (extraLifeGiven || 0) + 1;
        lives++;
    }
}

function stompCube(row, col) {
    var cube = cubeAt(row, col);
    if (!cube) return;
    var tgt = targetState();
    var next = nextCubeState(cube.state);
    if (next !== cube.state) {
        cube.state = next;
        if (cube.state === tgt) { score += 25; checkExtraLife(); }
        else if (cube.state > 0 && cube.state < tgt) { score += 15; checkExtraLife(); }
    }
}

function initRound() {
    levelWon = false;
    cubeStates = [];
    for (var r = 0; r < ROWS; r++)
        for (var c = 0; c <= r; c++)
            cubeStates.push({ row: r, col: c, state: 0 });

    player = {
        row: 0, col: 0, dead: false, deathTimer: 0,
        jumping: false, jumpT: 0,
        jumpDur: PLAYER_JUMP_DUR * speedMultiplier(),
        destRow: null, destCol: null
    };

    var dc = discConfig();
    discs = [];
    for (var i = 0; i < dc.length; i++)
        discs.push({ side: dc[i].side, row: dc[i].row, active: true });
    enemies = [];
    turnCount = 0;
    frameCount = 0;
    freezeTimer = 0;
    aiDetailPath = []; aiTourDots = [];
    aiTour = []; aiTourIdx = 0; aiBoardSig = '';
    aiTourInit();

    // Arcade-accurate enemy spawn schedule (frame-based, same as HTML)
    if (!noEnemies) {
        var lv = arcadeLevel();
        scheduleSpawn(180);                                    // Coily egg (~3s)
        if (hasRedBall())     scheduleSpawn(300, 'redball');    // ~5s
        if (hasSlick())       scheduleSpawn(900, 'slick');      // ~15s
        if (hasGreenBall())   scheduleSpawn(540, 'greenball');   // ~9s
        if (hasUggWrongway()) scheduleSpawn(660, 'ugg');        // ~11s
        if (hasUggWrongway()) scheduleSpawn(780, 'wrongway');   // ~13s
        if (lv >= 3 && hasRedBall()) scheduleSpawn(600, 'redball');
        if (lv >= 4 && hasSlick())   scheduleSpawn(1080, 'slick');
    }
}

function scheduleSpawn(delay, forcedType) {
    enemies.push({ type: 'spawn-timer', timer: delay, forcedType: forcedType || null });
}

function spawnEnemy(forcedType) {
    var type = forcedType;
    if (!type) {
        var hasCoily = false;
        for (var i = 0; i < enemies.length; i++)
            if (enemies[i].type === 'coily' || enemies[i].type === 'egg') { hasCoily = true; break; }
        type = hasCoily ? 'redball' : 'egg';
    }
    var sm = speedMultiplier();
    var spawnCol = Math.floor(Math.random() * 2);
    if (type === 'egg') {
        enemies.push({ type: 'egg', row: 1, col: spawnCol, hops: 0,
            jumping: false, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * sm,
            moveTimer: 0, moveInterval: enemyMoveInterval('egg'),
            destRow: null, destCol: null });
    } else if (type === 'redball') {
        enemies.push({ type: 'redball', row: 1, col: spawnCol,
            jumping: false, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * sm,
            moveTimer: 0, moveInterval: enemyMoveInterval('redball'),
            destRow: null, destCol: null });
    } else if (type === 'greenball') {
        enemies.push({ type: 'greenball', row: 1, col: spawnCol,
            jumping: false, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * sm,
            moveTimer: 0, moveInterval: enemyMoveInterval('greenball'),
            destRow: null, destCol: null });
    } else if (type === 'slick') {
        enemies.push({ type: 'slick', row: 1, col: spawnCol,
            jumping: false, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * sm,
            moveTimer: 0, moveInterval: enemyMoveInterval('slick'),
            destRow: null, destCol: null });
    } else if (type === 'ugg') {
        enemies.push({ type: 'ugg', row: ROWS - 1, col: ROWS - 1,
            jumping: false, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * sm,
            moveTimer: 0, moveInterval: enemyMoveInterval('ugg'),
            destRow: null, destCol: null });
    } else if (type === 'wrongway') {
        enemies.push({ type: 'wrongway', row: ROWS - 1, col: 0,
            jumping: false, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * sm,
            moveTimer: 0, moveInterval: enemyMoveInterval('wrongway'),
            destRow: null, destCol: null });
    }
}

var deathLog = [];
function killPlayer(reason) {
    if (player.dead) return;
    player.dead = true;
    player.deathTimer = 90; // ~1.5s at 60fps (matches HTML)
    lives--;
    var hasCoily = false;
    for (var di = 0; di < enemies.length; di++) if (enemies[di].type === 'coily') { hasCoily = true; break; }
    deathLog.push({ reason: reason || 'unknown', row: player.row, col: player.col, round: round, mode: hasCoily ? 2 : 1 });
    if (verbose) console.log('  KILL: ' + (reason || 'unknown') + ' at (' + player.row + ',' + player.col + ') lives=' + lives + ' mode=' + (hasCoily ? 2 : 1));
}

function useDisc(idx) {
    var disc = discs[idx];
    disc.active = false;
    var exitRow = disc.row;
    var discSide = disc.side;
    var coilyDied = false;
    var survived = [];
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'coily') {
            var bestDir = null, bestDist = Infinity;
            for (var k = 0; k < DIR_KEYS.length; k++) {
                var dk = DIRS[DIR_KEYS[k]];
                var nr = e.row + dk.dr, nc = e.col + dk.dc;
                var dist = Math.abs(exitRow - 1 - nr) + Math.abs((discSide === 0 ? 0 : exitRow) - nc);
                if (dist < bestDist) { bestDist = dist; bestDir = { nr: nr, nc: nc }; }
            }
            if (bestDir && !isValidPos(bestDir.nr, bestDir.nc)) {
                score += 500; checkExtraLife();
                coilyDied = true;
            } else {
                survived.push(e);
            }
        } else if (e.type === 'spawn-timer') {
            survived.push(e);
        } else {
            survived.push(e);
        }
    }
    if (coilyDied) {
        var kept = [];
        for (var i = 0; i < survived.length; i++)
            if (survived[i].type === 'spawn-timer') kept.push(survived[i]);
        enemies = kept;
    } else {
        enemies = survived;
    }
    player.row = 0; player.col = 0;
    player.jumping = false;
    stompCube(0, 0);
    // Disc ride takes ~83 frames in HTML; simulate as instant but schedule respawn
    if (!noEnemies) scheduleSpawn(180);
}

function tryMove(dirKey) {
    if (player.dead || player.jumping) return false;
    var d = DIRS[dirKey]; if (!d) return false;
    var nr = player.row + d.dr, nc = player.col + d.dc;

    if (!isValidPos(nr, nc)) {
        for (var di = 0; di < discs.length; di++) {
            var disc = discs[di];
            if (!disc.active) continue;
            var isLeft = (disc.side === 0 && dirKey === 'UL' && player.col === 0 && player.row === disc.row);
            var isRight = (disc.side === 1 && dirKey === 'UR' && player.col === player.row && player.row === disc.row);
            if (isLeft || isRight) {
                useDisc(di); return true;
            }
        }
        killPlayer('fell off edge to (' + nr + ',' + nc + ')');
        return false;
    }

    // Start jump animation
    player.jumping = true;
    player.jumpT = 0;
    player.jumpDur = PLAYER_JUMP_DUR * speedMultiplier();
    player.destRow = nr;
    player.destCol = nc;
    return true;
}

// Called when player lands (jump complete)
function onPlayerLand() {
    stompCube(player.row, player.col);
    checkPlayerEnemyCollision();
    if (!player.dead && allColored()) {
        score += roundCompletionBonus();
        score += unusedDiscBonus();
        checkExtraLife();
        levelWon = true;
    }
}

function checkPlayerEnemyCollision() {
    if (player.dead) return;
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;
        if (e.row === player.row && e.col === player.col) {
            if (e.type === 'slick') {
                score += 300; checkExtraLife();
                enemies.splice(i, 1); i--;
            } else if (e.type === 'greenball') {
                score += 100; checkExtraLife();
                freezeTimer = 300; // ~5s at 60fps (matches HTML's 5 * ~60 frames)
                enemies.splice(i, 1); i--;
            } else {
                killPlayer('landed on ' + e.type + '@(' + e.row + ',' + e.col + ')'); return;
            }
        }
    }
}

// ─── Frame-based enemy update (matches HTML's updateEnemies) ────────────────
function updateEnemies() {
    // Tick spawn timers (always tick, even during freeze)
    for (var i = enemies.length - 1; i >= 0; i--) {
        if (enemies[i].type === 'spawn-timer') {
            enemies[i].timer--;
            if (enemies[i].timer <= 0) {
                var ft = enemies[i].forcedType;
                enemies.splice(i, 1);
                spawnEnemy(ft);
            }
        }
    }

    // Green ball freeze: enemies don't move while frozen
    if (freezeTimer > 0) { freezeTimer--; return; }

    for (var i = enemies.length - 1; i >= 0; i--) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;

        // Jump animation
        if (e.jumping) {
            var prevT = e.jumpT;
            e.jumpT += e.jumpDur;
            // At apex, commit position
            if (prevT < 0.5 && e.jumpT >= 0.5 && e.destRow != null) {
                e.row = e.destRow; e.col = e.destCol;
                e.destRow = null; e.destCol = null;
            }
            if (e.jumpT >= 1) {
                e.jumpT = 1; e.jumping = false;
                if (e.destRow != null) { e.row = e.destRow; e.col = e.destCol; e.destRow = null; e.destCol = null; }
                if (e.falling) {
                    var ft = e.type;
                    enemies.splice(i, 1);
                    if (ft === 'egg' || ft === 'coily') { if (!noEnemies) scheduleSpawn(180); }
                    else if (ft === 'redball' && hasRedBall()) scheduleSpawn(Math.max(120, 240 - Math.floor(round / 2) * 15), 'redball');
                    else if (ft === 'greenball' && hasGreenBall()) scheduleSpawn(540, 'greenball');
                    else if (ft === 'slick' && hasSlick()) scheduleSpawn(720, 'slick');
                    else if (ft === 'ugg' && hasUggWrongway()) scheduleSpawn(540, 'ugg');
                    else if (ft === 'wrongway' && hasUggWrongway()) scheduleSpawn(600, 'wrongway');
                    continue;
                }
                if (e.willHatch) {
                    e.willHatch = false;
                    e.type = 'coily';
                    e.moveInterval = enemyMoveInterval('coily');
                }
                // On-land effects
                if (e.type === 'slick') {
                    var cube = cubeAt(e.row, e.col);
                    if (cube && cube.state > 0) cube.state--;
                    if (e.row >= ROWS - 1) {
                        enemies.splice(i, 1);
                        if (hasSlick()) scheduleSpawn(720, 'slick');
                        continue;
                    }
                }
                // Post-land collision
                if (!player.dead && e.row === player.row && e.col === player.col) {
                    if (e.type === 'slick') {
                        score += 300; checkExtraLife();
                        enemies.splice(i, 1);
                    } else if (e.type === 'greenball') {
                        score += 100; checkExtraLife();
                        freezeTimer = 300;
                        enemies.splice(i, 1);
                    } else {
                        killPlayer(e.type + ' moved onto @(' + e.row + ',' + e.col + ')');
                    }
                }
            }
            continue; // don't tick move timer while jumping
        }

        // Idle: tick move timer
        e.moveTimer++;
        if (e.moveTimer < e.moveInterval) continue;
        e.moveTimer = 0;

        // Execute enemy move
        if (e.type === 'egg') {
            var dir = Math.random() < 0.5 ? 'DL' : 'DR';
            var delta = DIRS[dir];
            var nr = e.row + delta.dr, nc = e.col + delta.dc;
            if (isValidPos(nr, nc)) {
                e.hops++;
                enemyJumpTo(e, nr, nc);
                if (e.hops >= 6 || nr >= ROWS - 1) {
                    e.willHatch = true;
                }
            } else {
                enemyJumpTo(e, nr, nc);
                e.falling = true;
            }
        } else if (e.type === 'coily') {
            var bestDir = null, bestDist = Infinity;
            for (var k = 0; k < DIR_KEYS.length; k++) {
                var dk = DIRS[DIR_KEYS[k]];
                var enr = e.row + dk.dr, enc = e.col + dk.dc;
                if (!isValidPos(enr, enc)) continue;
                var dist = Math.abs(player.row - enr) + Math.abs(player.col - enc);
                if (dist < bestDist) { bestDist = dist; bestDir = { nr: enr, nc: enc }; }
            }
            if (bestDir) {
                enemyJumpTo(e, bestDir.nr, bestDir.nc);
            } else {
                enemyJumpTo(e, e.row, e.col);
                e.falling = true;
            }
        } else if (e.type === 'redball') {
            var dir = Math.random() < 0.5 ? 'DL' : 'DR';
            var delta = DIRS[dir];
            var nr = e.row + delta.dr, nc = e.col + delta.dc;
            if (isValidPos(nr, nc)) {
                enemyJumpTo(e, nr, nc);
            } else {
                enemyJumpTo(e, nr, nc);
                e.falling = true;
            }
        } else if (e.type === 'greenball') {
            var dir = Math.random() < 0.5 ? 'DL' : 'DR';
            var delta = DIRS[dir];
            var nr = e.row + delta.dr, nc = e.col + delta.dc;
            if (isValidPos(nr, nc)) {
                enemyJumpTo(e, nr, nc);
            } else {
                enemyJumpTo(e, nr, nc);
                e.falling = true;
            }
        } else if (e.type === 'slick') {
            var dir = Math.random() < 0.5 ? 'DL' : 'DR';
            var delta = DIRS[dir];
            var nr = e.row + delta.dr, nc = e.col + delta.dc;
            if (isValidPos(nr, nc)) {
                enemyJumpTo(e, nr, nc);
            } else {
                enemyJumpTo(e, nr, nc);
                e.falling = true;
            }
        } else if (e.type === 'ugg') {
            var udir = Math.random() < 0.5;
            var unr, unc;
            if (udir) { unr = e.row - 1; unc = e.col - 1; }
            else      { unr = e.row;     unc = e.col - 1; }
            if (isValidPos(unr, unc)) {
                enemyJumpTo(e, unr, unc);
            } else {
                enemyJumpTo(e, unr, unc);
                e.falling = true;
            }
        } else if (e.type === 'wrongway') {
            var wdir = Math.random() < 0.5;
            var wnr, wnc;
            if (wdir) { wnr = e.row - 1; wnc = e.col;     }
            else      { wnr = e.row;     wnc = e.col + 1;  }
            if (isValidPos(wnr, wnc)) {
                enemyJumpTo(e, wnr, wnc);
            } else {
                enemyJumpTo(e, wnr, wnc);
                e.falling = true;
            }
        }
    }
}

function enemyJumpTo(e, nr, nc) {
    e.jumping = true;
    e.jumpT = 0;
    e.jumpDur = ENEMY_JUMP_DUR * speedMultiplier();
    e.destRow = nr; e.destCol = nc;
}

// ─── Frame-based player update ──────────────────────────────────────────────
function updatePlayer() {
    if (player.dead) {
        player.deathTimer--;
        if (player.deathTimer <= 0 && lives > 0) {
            player.dead = false;
            player.row = 0; player.col = 0;
            player.jumping = false;
            stompCube(0, 0);
            var kept = [];
            for (var i = 0; i < enemies.length; i++)
                if (enemies[i].type === 'spawn-timer') kept.push(enemies[i]);
            enemies = kept;
            if (!noEnemies) {
                scheduleSpawn(180);                                   // Coily egg
                if (hasRedBall())     scheduleSpawn(240, 'redball');
                if (hasSlick())       scheduleSpawn(720, 'slick');
                if (hasGreenBall())   scheduleSpawn(480, 'greenball');
                if (hasUggWrongway()) scheduleSpawn(540, 'ugg');
                if (hasUggWrongway()) scheduleSpawn(660, 'wrongway');
            }
        }
        return;
    }

    if (player.jumping) {
        var prevT = player.jumpT;
        player.jumpT += player.jumpDur;
        // At apex, commit position
        if (prevT < 0.5 && player.jumpT >= 0.5 && player.destRow != null) {
            player.row = player.destRow;
            player.col = player.destCol;
            player.destRow = null;
            player.destCol = null;
        }
        if (player.jumpT >= 1) {
            player.jumpT = 1;
            player.jumping = false;
            if (player.destRow != null) {
                player.row = player.destRow;
                player.col = player.destCol;
                player.destRow = null;
                player.destCol = null;
            }
            onPlayerLand();
        }
    }
}

// ─── Per-frame collision check (same as HTML) ───────────────────────────────
function checkFrameCollision() {
    if (player.dead) return;
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;
        if (e.row === player.row && e.col === player.col) {
            if (e.type === 'slick') {
                score += 300; checkExtraLife();
                enemies.splice(i, 1); i--;
            } else if (e.type === 'greenball') {
                score += 100; checkExtraLife();
                freezeTimer = 300;
                enemies.splice(i, 1); i--;
            } else {
                killPlayer(e.type + ' collision @(' + e.row + ',' + e.col + ')');
                return;
            }
        }
    }
}

// ─── Main simulation frame (matches HTML's update()) ────────────────────────
function simFrame() {
    if (levelWon) return null;
    frameCount++;

    updatePlayer();
    updateEnemies();
    checkFrameCollision();

    // AI input: when player is ready (not jumping, not dead)
    if (!player.jumping && !player.dead && !levelWon) {
        var dir = computeAIMove();
        if (dir && dir !== 'STAY') {
            tryMove(dir);
            return dir;
        }
        return dir === 'STAY' ? 'STAY' : null;
    }
    return null;
}

// ─── Visualization ───────────────────────────────────────────────────────────
function countRemaining() {
    var tgt = targetState();
    var n = 0;
    for (var i = 0; i < cubeStates.length; i++)
        if (cubeStates[i].state < tgt) n++;
    return n;
}

function enemySummary() {
    var parts = [];
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') { parts.push('spawn(' + e.timer + ')'); continue; }
        parts.push(e.type + '@(' + e.row + ',' + e.col + ')');
    }
    return parts.length ? parts.join(' ') : 'none';
}

// ─── Run simulation ──────────────────────────────────────────────────────────
function runGame(maxRounds, verbose) {
    round = startRound;
    score = 0;
    lives = 3;
    extraLifeGiven = 0;
    var totalDeaths = 0;
    var prevLives = lives;

    for (; round <= maxRounds; round++) {
        initRound();
        var moveNum = 0;
        var maxFrames = 200 * 60; // ~200 seconds at 60fps

        if (verbose) {
            console.log('\n' + '='.repeat(50));
            console.log('LV ' + arcadeLevel() + ' ROUND ' + ((round - 1) % 4 + 1) + ' (target: ' + targetState() + ', lv' + arcadeLevel() + ')');
            console.log('='.repeat(50));
        }

        for (var frame = 0; frame < maxFrames; frame++) {
            var aiMove = simFrame();

            if (lives !== prevLives) {
                if (lives < prevLives) {
                    totalDeaths += prevLives - lives;
                }
                prevLives = lives;
            }
            if (lives <= 0) {
                console.log('GAME OVER at round ' + round + ', move ' + moveNum + ', score=' + score);
                return { rounds: round, score: score, deaths: totalDeaths };
            }

            if (aiMove && aiMove !== 'STAY') {
                moveNum++;
                if (verbose) {
                    var remaining = countRemaining();
                    var tc = mstTourCost(posToIdx[player.row * ROWS + player.col], cubeStates, targetState(), arcadeLevel());
                    var extra = '';
                    if (remaining <= 5) {
                        var tgt = targetState();
                        var uncolored = [];
                        for (var ci = 0; ci < cubeStates.length; ci++)
                            if (cubeStates[ci].state < tgt) uncolored.push('(' + cubeStates[ci].row + ',' + cubeStates[ci].col + ')');
                        extra = '  need=' + uncolored.join(',');
                    }
                    console.log('  #' + moveNum + ' ' + aiMove +
                        ' -> (' + player.row + ',' + player.col + ')  left=' + remaining +
                        '  h=' + tc +
                        (enemies.length > 0 ? '  enemies: ' + enemySummary() : '') + extra);
                }
            }

            if (levelWon) {
                round++;
                var lvl = Math.min(9, Math.ceil((round-1) / 4));
                var rnd = ((round - 2) % 4 + 1);
                if (verbose) console.log('  Lv' + lvl + '-' + rnd + ' COMPLETE in ' + moveNum + ' moves! Score=' + score);
                else console.log('Lv' + lvl + '-' + rnd + ' done in ' + moveNum + ' moves, deaths=' + totalDeaths + ', score=' + score);
                break;
            }
        }

        if (!levelWon && frame >= maxFrames) {
            console.log('  Round ' + round + ' TIMEOUT after ' + maxFrames + ' frames');
        }

        if (levelWon) { round--; }
    }

    return { rounds: maxRounds, score: score, deaths: totalDeaths };
}

// ─── Main ────────────────────────────────────────────────────────────────────
var verbose = process.argv.includes('-v') || process.argv.includes('--verbose');
var noEnemies = process.argv.includes('--no-enemies');
var numRounds = 5;
var startRound = 1;
for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--start-round' && i + 1 < process.argv.length) {
        startRound = parseInt(process.argv[++i]) || 1;
    }
}
for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--start-round') { i++; continue; }
    var n = parseInt(process.argv[i]);
    if (!isNaN(n) && n > 0) { numRounds = n; break; }
}

console.log('Running ' + numRounds + ' rounds from round ' + startRound + (verbose ? ' (verbose)' : '') + '...\n');
var result = runGame(startRound + numRounds - 1, verbose);
console.log('\nFinal: rounds=' + result.rounds + ' score=' + result.score + ' deaths=' + result.deaths);
// Death summary
if (deathLog.length > 0) {
    var byType = {}, byRow = {};
    for (var di = 0; di < deathLog.length; di++) {
        var dl = deathLog[di];
        var t = dl.reason.split(' ')[0]; // first word = type
        byType[t] = (byType[t] || 0) + 1;
        byRow[dl.row] = (byRow[dl.row] || 0) + 1;
    }
    console.log('Deaths by cause: ' + JSON.stringify(byType));
    console.log('Deaths by row: ' + JSON.stringify(byRow));
}
if (astarStats.solved + astarStats.fallbacks > 0) {
    console.log('A* stats: solved=' + astarStats.solved + ' fallbacks=' + astarStats.fallbacks +
        ' avgNodes=' + Math.round(astarStats.totalNodes / (astarStats.solved + astarStats.fallbacks)) +
        ' cacheHits=' + astarTourCacheHits + ' cacheMisses=' + astarTourCacheMisses);
}
