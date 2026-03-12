#!/usr/bin/env node
// Q*bert AI test harness — turn-based simulation
// Loads shared AI from qbert-ai.js, adds game simulation on top.

// ─── Load shared AI module ───────────────────────────────────────────────────
var player, enemies, cubeStates, discs, round, score;
var aiTour, aiTourIdx, aiBoardSig, aiDetailPath, aiTourDots;
var astarStats = { solved: 0, fallbacks: 0, totalNodes: 0, cacheHits: 0 };
eval(require('fs').readFileSync(__dirname + '/qbert-ai.js', 'utf8'));

// ─── Simulation constants ────────────────────────────────────────────────────
var SIM_HOPS_PER_MOVE = {
    egg:       3,
    coily:     2,
    redball:   3,
    greenball: 3,
    slick:     3,
    ugg:       3,
    wrongway:  3
};

var lives, extraLifeGiven, levelWon, turnCount;

// ─── exCloneState (test-specific: uses moveCountdown directly) ───────────────
function exCloneState() {
    var tgt = targetState();
    var cs = new Array(cubeStates.length);
    for (var i = 0; i < cubeStates.length; i++)
        cs[i] = { row: cubeStates[i].row, col: cubeStates[i].col, state: cubeStates[i].state };
    var ens = [];
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;
        if (e.type === 'greenball' || e.type === 'slick') continue;
        var interval = EX_HOPS_PER_MOVE[e.type] || 4;
        var cd = e.moveCountdown !== undefined ? e.moveCountdown : interval;
        ens.push({ type: e.type, row: e.row, col: e.col, hops: e.hops || 0, countdown: cd });
    }
    var colored = 0;
    for (var i = 0; i < cs.length; i++) colored += Math.min(cs[i].state, tgt);
    var ds = [];
    for (var i = 0; i < discs.length; i++)
        ds.push({ side: discs[i].side, row: discs[i].row, active: discs[i].active });
    return { pr: player.row, pc: player.col, cubes: cs, enemies: ens,
             alive: true, score: 0, cubesColored: colored, tgt: tgt,
             discs: ds, lv: arcadeLevel() };
}

// ─── computeAIMove (test-specific: no visualization) ─────────────────────────
function computeAIMove() {
    exMemoTable = {};
    var tmpSt = exCloneState();
    var bestDir = null, bestVal = -Infinity;
    for (var k = 0; k < 4; k++) {
        if (!exCanMove(tmpSt, DIR_KEYS[k])) continue;
        var val = expectimaxEval(DIR_KEYS[k]);
        if (val > bestVal) {
            bestVal = val;
            bestDir = DIR_KEYS[k];
        }
    }
    if (boardSig() !== aiBoardSig || aiTour.length === 0) buildTour();
    return bestDir || 'DL';
}

// ─── Game simulation ─────────────────────────────────────────────────────────
function checkExtraLife() {
    if (!extraLifeGiven && score >= 8000) { extraLifeGiven = true; lives++; }
}

function stompCube(row, col) {
    var cube = cubeAt(row, col);
    if (!cube) return;
    var tgt = targetState();
    var next = nextCubeState(cube.state);
    if (next !== cube.state) {
        cube.state = next;
        if (cube.state <= tgt && cube.state > 0) { score += 25; checkExtraLife(); }
    }
}

function initRound() {
    levelWon = false;
    cubeStates = [];
    for (var r = 0; r < ROWS; r++)
        for (var c = 0; c <= r; c++)
            cubeStates.push({ row: r, col: c, state: 0 });

    player = { row: 0, col: 0, dead: false, deathTimer: 0 };
    stompCube(0, 0);

    var dc = discConfig();
    discs = [];
    for (var i = 0; i < dc.length; i++)
        discs.push({ side: dc[i].side, row: dc[i].row, active: true });
    enemies = [];
    turnCount = 0;
    aiDetailPath = []; aiTourDots = [];
    aiTour = []; aiTourIdx = 0; aiBoardSig = '';

    scheduleSpawn(8);              // Coily egg
    scheduleSpawn(4, 'redball');
    if (round >= 3) scheduleSpawn(10, 'greenball');
    if (round >= 4) scheduleSpawn(15, 'slick');
    // Ugg/Wrongway appear from round 3 (arcade: level 1 round 3)
    if (round >= 3) scheduleSpawn(12, 'ugg');
    if (round >= 3) scheduleSpawn(14, 'wrongway');
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
    var cd = SIM_HOPS_PER_MOVE[type] || 4;
    if (type === 'egg') {
        enemies.push({ type: 'egg', row: 0, col: 0, hops: 0, moveCountdown: cd });
    } else if (type === 'redball') {
        var spawnCol = Math.floor(Math.random() * 2);
        enemies.push({ type: 'redball', row: 1, col: spawnCol, moveCountdown: cd });
    } else if (type === 'greenball') {
        var spawnCol = Math.floor(Math.random() * 2);
        enemies.push({ type: 'greenball', row: 1, col: spawnCol, moveCountdown: cd });
    } else if (type === 'slick') {
        var spawnCol = Math.floor(Math.random() * 2);
        enemies.push({ type: 'slick', row: 1, col: spawnCol, moveCountdown: cd });
    } else if (type === 'ugg') {
        // Ugg spawns bottom-right, moves upward
        enemies.push({ type: 'ugg', row: ROWS - 1, col: ROWS - 1, moveCountdown: cd });
    } else if (type === 'wrongway') {
        // Wrongway spawns bottom-left, moves upward
        enemies.push({ type: 'wrongway', row: ROWS - 1, col: 0, moveCountdown: cd });
    }
}

function killPlayer() {
    if (player.dead) return;
    player.dead = true;
    player.deathTimer = 3;
    lives--;
}

function useDisc(idx) {
    discs[idx].active = false;
    score += 300; checkExtraLife();
    var survived = [];
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'coily' || e.type === 'egg') { score += 300; checkExtraLife(); }
        else survived.push(e);
    }
    enemies = survived;
    player.row = 0; player.col = 0;
    stompCube(0, 0);
    scheduleSpawn(8);
}

function tryMove(dirKey) {
    if (player.dead) return false;
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
        killPlayer();
        return false;
    }

    player.row = nr; player.col = nc;
    stompCube(nr, nc);
    checkPlayerEnemyCollision();
    return !player.dead;
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
                enemies.splice(i, 1); i--;
            } else {
                killPlayer(); return;
            }
        }
    }
}

function moveEnemies() {
    // Tick spawn timers
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

    // Tick countdown and move enemies whose countdown reaches 0
    for (var i = enemies.length - 1; i >= 0; i--) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;

        e.moveCountdown--;
        if (e.moveCountdown > 0) continue;
        e.moveCountdown = SIM_HOPS_PER_MOVE[e.type] || 4;

        if (e.type === 'egg') {
            var dir = Math.random() < 0.5 ? 'DL' : 'DR';
            var delta = DIRS[dir];
            var nr = e.row + delta.dr, nc = e.col + delta.dc;
            if (isValidPos(nr, nc)) {
                e.hops++;
                e.row = nr; e.col = nc;
                if (e.hops >= 6 || nr >= ROWS - 1) e.type = 'coily';
            } else {
                e.type = 'coily';
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
                e.row = bestDir.nr; e.col = bestDir.nc;
            } else {
                enemies.splice(i, 1);
                scheduleSpawn(8);
                continue;
            }
        } else if (e.type === 'redball') {
            var rbdir = Math.random() < 0.5 ? 'DL' : 'DR';
            var rbdelta = DIRS[rbdir];
            var rbnr = e.row + rbdelta.dr, rbnc = e.col + rbdelta.dc;
            if (isValidPos(rbnr, rbnc)) {
                e.row = rbnr; e.col = rbnc;
            } else {
                enemies.splice(i, 1);
                scheduleSpawn(Math.max(5, 8 - Math.floor(round / 2)), 'redball');
                continue;
            }
        } else if (e.type === 'greenball') {
            var gbdir = Math.random() < 0.5 ? 'DL' : 'DR';
            var gbdelta = DIRS[gbdir];
            var gbnr = e.row + gbdelta.dr, gbnc = e.col + gbdelta.dc;
            if (isValidPos(gbnr, gbnc)) {
                e.row = gbnr; e.col = gbnc;
            } else {
                enemies.splice(i, 1);
                if (round >= 3) scheduleSpawn(12, 'greenball');
                continue;
            }
        } else if (e.type === 'slick') {
            var sdir = Math.random() < 0.5 ? 'DL' : 'DR';
            var sdelta = DIRS[sdir];
            var snr = e.row + sdelta.dr, snc = e.col + sdelta.dc;
            if (isValidPos(snr, snc)) {
                e.row = snr; e.col = snc;
            } else {
                enemies.splice(i, 1);
                if (round >= 4) scheduleSpawn(15, 'slick');
                continue;
            }
        } else if (e.type === 'ugg') {
            // Ugg moves upward from bottom-right: random UL or UR
            var udir = Math.random() < 0.5;
            var unr, unc;
            if (udir) { unr = e.row - 1; unc = e.col - 1; } // UL
            else      { unr = e.row - 1; unc = e.col; }      // UR
            if (isValidPos(unr, unc)) {
                e.row = unr; e.col = unc;
            } else {
                enemies.splice(i, 1);
                if (round >= 3) scheduleSpawn(12, 'ugg');
                continue;
            }
        } else if (e.type === 'wrongway') {
            // Wrongway moves upward from bottom-left: random UR or UL
            var wdir = Math.random() < 0.5;
            var wnr, wnc;
            if (wdir) { wnr = e.row - 1; wnc = e.col; }      // UR
            else      { wnr = e.row - 1; wnc = e.col - 1; }  // UL
            if (isValidPos(wnr, wnc)) {
                e.row = wnr; e.col = wnc;
            } else {
                enemies.splice(i, 1);
                if (round >= 3) scheduleSpawn(14, 'wrongway');
                continue;
            }
        }
    }

    // Apply slick effects and check collisions after all moves
    for (var i = enemies.length - 1; i >= 0; i--) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;

        if (e.type === 'slick') {
            var cube = cubeAt(e.row, e.col);
            if (cube && cube.state > 0) cube.state--;
            if (e.row >= ROWS - 1) {
                enemies.splice(i, 1);
                if (round >= 4) scheduleSpawn(15, 'slick');
                continue;
            }
        }

        if (!player.dead && e.row === player.row && e.col === player.col) {
            if (e.type === 'slick') {
                score += 300; checkExtraLife();
                enemies.splice(i, 1);
            } else if (e.type === 'greenball') {
                score += 100; checkExtraLife();
                enemies.splice(i, 1);
            } else {
                killPlayer();
            }
        }
    }
}

function simTurn() {
    turnCount++;
    if (levelWon) return null;

    if (player.dead) {
        player.deathTimer--;
        if (player.deathTimer <= 0 && lives > 0) {
            player.dead = false;
            player.row = 0; player.col = 0;
            stompCube(0, 0);
            var kept = [];
            for (var i = 0; i < enemies.length; i++)
                if (enemies[i].type === 'spawn-timer') kept.push(enemies[i]);
            enemies = kept;
            scheduleSpawn(7);
            scheduleSpawn(5, 'redball');
            if (round >= 4) scheduleSpawn(13, 'slick');
            if (round >= 3) scheduleSpawn(10, 'greenball');
            if (round >= 3) scheduleSpawn(12, 'ugg');
            if (round >= 3) scheduleSpawn(14, 'wrongway');
        }
        return null;
    }

    var dir = computeAIMove();
    if (!dir) return null;

    if (!tryMove(dir)) return dir;

    if (!player.dead && allColored()) {
        score += 1000; checkExtraLife();
        levelWon = true;
        return dir;
    }

    if (!player.dead) moveEnemies();

    return dir;
}

// ─── Visualization ───────────────────────────────────────────────────────────
function drawBoard() {
    var tgt = targetState();
    var grid = {};
    for (var i = 0; i < cubeStates.length; i++) {
        var c = cubeStates[i];
        grid[c.row + ',' + c.col] = c.state >= tgt ? '#' : '.';
    }
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;
        var k = e.row + ',' + e.col;
        if (e.type === 'coily') grid[k] = 'C';
        else if (e.type === 'egg') grid[k] = 'E';
        else if (e.type === 'redball') grid[k] = 'R';
        else if (e.type === 'greenball') grid[k] = 'G';
        else if (e.type === 'slick') grid[k] = 'S';
        else if (e.type === 'ugg') grid[k] = 'U';
        else if (e.type === 'wrongway') grid[k] = 'W';
    }
    grid[player.row + ',' + player.col] = '@';

    var lines = [];
    for (var r = 0; r < ROWS; r++) {
        var pad = '';
        for (var p = 0; p < ROWS - 1 - r; p++) pad += ' ';
        var row = '';
        for (var c = 0; c <= r; c++) {
            var ch = grid[r + ',' + c] || '?';
            row += ch + ' ';
        }
        lines.push(pad + row.trim());
    }
    return lines.join('\n');
}

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
    round = 1;
    score = 0;
    lives = 3;
    extraLifeGiven = false;
    var totalDeaths = 0;
    var prevLives = lives;

    for (; round <= maxRounds; round++) {
        initRound();
        var moveNum = 0;
        var maxTurns = 500;

        if (verbose) {
            console.log('\n' + '='.repeat(50));
            console.log('LV ' + arcadeLevel() + ' ROUND ' + ((round - 1) % 4 + 1) + ' (target: ' + targetState() + ', lv' + arcadeLevel() + ')');
            console.log('='.repeat(50));
        }

        for (var turn = 0; turn < maxTurns; turn++) {
            var aiMove = simTurn();

            if (lives < prevLives) {
                totalDeaths += prevLives - lives;
                if (verbose) console.log('  Turn ' + turn + ': DIED! Lives=' + lives);
                prevLives = lives;
            }
            if (lives <= 0) {
                console.log('GAME OVER at round ' + round + ', move ' + moveNum + ', score=' + score);
                return { rounds: round, score: score, deaths: totalDeaths };
            }

            if (aiMove) {
                moveNum++;
                if (verbose) {
                    var remaining = countRemaining();
                    var extra = '';
                    if (remaining <= 3) {
                        var tgt = targetState();
                        var uncolored = [];
                        for (var ci = 0; ci < cubeStates.length; ci++)
                            if (cubeStates[ci].state < tgt) uncolored.push('(' + cubeStates[ci].row + ',' + cubeStates[ci].col + ')');
                        extra = '  need=' + uncolored.join(',');
                    }
                    console.log('  Move ' + moveNum + ': ' + aiMove +
                        ' -> (' + player.row + ',' + player.col + ')  remaining=' + remaining +
                        '  enemies: ' + enemySummary() + extra);
                    if (moveNum % 10 === 0) console.log(drawBoard());
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

        if (!levelWon && turn >= maxTurns) {
            console.log('  Round ' + round + ' TIMEOUT after ' + maxTurns + ' turns');
        }

        if (levelWon) { round--; }
    }

    return { rounds: maxRounds, score: score, deaths: totalDeaths };
}

// ─── Main ────────────────────────────────────────────────────────────────────
var verbose = process.argv.includes('-v') || process.argv.includes('--verbose');
var numRounds = 5;
for (var i = 2; i < process.argv.length; i++) {
    var n = parseInt(process.argv[i]);
    if (!isNaN(n) && n > 0) { numRounds = n; break; }
}

console.log('Running ' + numRounds + ' rounds' + (verbose ? ' (verbose)' : '') + '...\n');
var result = runGame(numRounds, verbose);
console.log('\nFinal: rounds=' + result.rounds + ' score=' + result.score + ' deaths=' + result.deaths);
if (astarStats.solved + astarStats.fallbacks > 0) {
    console.log('A* stats: solved=' + astarStats.solved + ' fallbacks=' + astarStats.fallbacks +
        ' avgNodes=' + Math.round(astarStats.totalNodes / (astarStats.solved + astarStats.fallbacks)) +
        ' cacheHits=' + astarTourCacheHits + ' cacheMisses=' + astarTourCacheMisses);
}
