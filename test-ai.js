#!/usr/bin/env node
// Q*bert AI test harness — turn-based simulation
// Loads shared AI from qbert-ai.js, adds game simulation on top.

// ─── Load shared AI module ───────────────────────────────────────────────────
var player, enemies, cubeStates, discs, round, score;
var aiTour, aiTourIdx, aiBoardSig, aiDetailPath, aiTourDots;
var astarStats = { solved: 0, fallbacks: 0, totalNodes: 0, cacheHits: 0 };
eval(require('fs').readFileSync(__dirname + '/qbert-ai.js', 'utf8'));

// ─── Simulation constants ────────────────────────────────────────────────────
// Arcade frame-accurate: enemy accumulates PLAYER_FRAMES/ENEMY_FRAMES per player hop
var SIM_MOVE_RATE = {
    egg:       9 / 12,   // 0.75
    coily:     9 / 12,   // 0.75
    redball:   9 / 12,   // 0.75
    greenball: 9 / 15,   // 0.60
    slick:     9 / 17,   // 0.53
    ugg:       9 / 12,   // 0.75
    wrongway:  9 / 12    // 0.75
};

var lives, extraLifeGiven, levelWon, turnCount, freezeTimer;

// ─── exCloneState (test-specific: uses accum directly) ───────────────────────
function exCloneState() {
    var tgt = targetState();
    var cs = new Array(cubeStates.length);
    for (var i = 0; i < cubeStates.length; i++)
        cs[i] = { row: cubeStates[i].row, col: cubeStates[i].col, state: cubeStates[i].state };
    var ens = [];
    // Only track enemies that matter for the search: Coily (deterministic),
    // and the nearest 2 random lethal enemies. This prevents cloud explosion
    // with many enemies while still modeling the most dangerous threats.
    var lethalRandom = [];
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;
        if (e.type === 'coily') {
            ens.push({ type: e.type, row: e.row, col: e.col, hops: e.hops || 0, accum: e.accum || 0 });
        } else if (e.type === 'slick' || e.type === 'greenball') {
            // Safe enemies: skip to save search time
            continue;
        } else {
            // Lethal enemies: track nearest ones (closer = more dangerous)
            var d = exBfsDist(player.row, player.col, e.row, e.col);
            lethalRandom.push({ e: e, dist: d });
        }
    }
    lethalRandom.sort(function(a, b) { return a.dist - b.dist; });
    for (var i = 0; i < Math.min(3, lethalRandom.length); i++) {
        var e = lethalRandom[i].e;
        ens.push({ type: e.type, row: e.row, col: e.col, hops: e.hops || 0, accum: e.accum || 0,
                    cloud: [{ row: e.row, col: e.col, prob: 1.0 }] });
    }
    var colored = 0;
    for (var i = 0; i < cs.length; i++) colored += Math.min(cs[i].state, tgt);
    var ds = [];
    for (var i = 0; i < discs.length; i++)
        ds.push({ side: discs[i].side, row: discs[i].row, active: discs[i].active });
    // Include imminent spawn timers for Ugg/Wrongway (dangerous spawn points)
    var spawns = [];
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer' && e.timer <= 3) {
            spawns.push({ timer: e.timer, forcedType: e.forcedType || null });
        }
    }
    return { pr: player.row, pc: player.col, cubes: cs, enemies: ens,
             alive: true, score: 0, cubesColored: colored, tgt: tgt,
             discs: ds, lv: arcadeLevel(), spawns: spawns };
}

// ─── computeAIMove (test-specific: no visualization) ─────────────────────────
function computeAIMove() {
    var bestDir = aiPickBestDir();
    if (boardSig() !== aiBoardSig || aiTour.length === 0) buildTour();
    return bestDir;
}

// ─── Game simulation ─────────────────────────────────────────────────────────
function checkExtraLife() {
    // First extra life at 8000, then every 14000 after that
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

    player = { row: 0, col: 0, dead: false, deathTimer: 0 };
    // In the arcade, Q*bert does NOT color (0,0) on spawn

    var dc = discConfig();
    discs = [];
    for (var i = 0; i < dc.length; i++)
        discs.push({ side: dc[i].side, row: dc[i].row, active: true });
    enemies = [];
    turnCount = 0;
    freezeTimer = 0;
    aiDetailPath = []; aiTourDots = [];
    aiTour = []; aiTourIdx = 0; aiBoardSig = '';
    aiTourInit();

    // Arcade-accurate enemy spawn schedule
    if (!noEnemies) {
        var lv = arcadeLevel();
        scheduleSpawn(8);                                  // Coily egg (always present)
        if (hasRedBall())     scheduleSpawn(4, 'redball');  // Red ball
        if (hasUggWrongway()) scheduleSpawn(12, 'ugg');
        if (hasUggWrongway()) scheduleSpawn(14, 'wrongway');
        if (hasSlick())       scheduleSpawn(15, 'slick');
        if (hasGreenBall())   scheduleSpawn(10, 'greenball');
        // Higher levels: additional enemies
        if (lv >= 3 && hasRedBall()) scheduleSpawn(20, 'redball'); // second red ball
        if (lv >= 4 && hasSlick())   scheduleSpawn(18, 'slick');   // second slick
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
    if (type === 'egg') {
        var spawnCol = Math.floor(Math.random() * 2);
        enemies.push({ type: 'egg', row: 1, col: spawnCol, hops: 0, accum: 0 });
    } else if (type === 'redball') {
        var spawnCol = Math.floor(Math.random() * 2);
        enemies.push({ type: 'redball', row: 1, col: spawnCol, accum: 0 });
    } else if (type === 'greenball') {
        var spawnCol = Math.floor(Math.random() * 2);
        enemies.push({ type: 'greenball', row: 1, col: spawnCol, accum: 0 });
    } else if (type === 'slick') {
        var spawnCol = Math.floor(Math.random() * 2);
        enemies.push({ type: 'slick', row: 1, col: spawnCol, accum: 0 });
    } else if (type === 'ugg') {
        enemies.push({ type: 'ugg', row: ROWS - 1, col: ROWS - 1, accum: 0 });
    } else if (type === 'wrongway') {
        enemies.push({ type: 'wrongway', row: ROWS - 1, col: 0, accum: 0 });
    }
}

function killPlayer(reason) {
    if (player.dead) return;
    player.dead = true;
    player.deathTimer = 3;
    lives--;
    if (verbose) console.log('  KILL: ' + (reason || 'unknown') + ' at (' + player.row + ',' + player.col + ') lives=' + lives);
}

function useDisc(idx) {
    var disc = discs[idx];
    disc.active = false;
    // Arcade: Coily only dies if his greedy chase toward Q*bert's disc position
    // would take him off the pyramid edge (he follows you off)
    var exitRow = disc.row;
    var discSide = disc.side;
    var exitCol = (discSide === 0) ? -1 : exitRow + 1;
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
    // Arcade: when Coily dies, all other enemies are also cleared
    if (coilyDied) {
        var kept = [];
        for (var i = 0; i < survived.length; i++)
            if (survived[i].type === 'spawn-timer') kept.push(survived[i]);
        enemies = kept;
    } else {
        enemies = survived;
    }
    player.row = 0; player.col = 0;
    stompCube(0, 0);
    if (!noEnemies) scheduleSpawn(8);
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
        killPlayer('fell off edge to (' + nr + ',' + nc + ')');
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
                freezeTimer = 5; // Freeze all enemies for ~5 turns
                enemies.splice(i, 1); i--;
            } else {
                killPlayer('landed on ' + e.type + '@(' + e.row + ',' + e.col + ')'); return;
            }
        }
    }
}

function moveEnemies() {
    // Tick spawn timers (spawns still happen during freeze)
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

    // Tick countdown and move enemies whose countdown reaches 0
    for (var i = enemies.length - 1; i >= 0; i--) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') continue;

        e.accum = (e.accum || 0) + (SIM_MOVE_RATE[e.type] || 0.75);
        if (e.accum < 1.0) continue;
        e.accum -= 1.0;

        if (e.type === 'egg') {
            var dir = Math.random() < 0.5 ? 'DL' : 'DR';
            var delta = DIRS[dir];
            var nr = e.row + delta.dr, nc = e.col + delta.dc;
            if (isValidPos(nr, nc)) {
                e.hops++;
                e.row = nr; e.col = nc;
                // Arcade: egg only hatches into Coily when it reaches the bottom row
                if (nr >= ROWS - 1) e.type = 'coily';
            } else {
                // Fell off the edge — remove and respawn
                enemies.splice(i, 1); i--;
                scheduleSpawn(8);
                continue;
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
                if (hasRedBall()) scheduleSpawn(Math.max(5, 8 - Math.floor(round / 2)), 'redball');
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
                if (hasGreenBall()) scheduleSpawn(12, 'greenball');
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
                if (hasSlick()) scheduleSpawn(15, 'slick');
                continue;
            }
        } else if (e.type === 'ugg') {
            // Arcade: Ugg spawns bottom-right, moves toward top-left.
            // Can move UL (row-1,col-1) or stay same row move left (row,col-1)
            // In pyramid terms: UL goes up-left, "left" means row stays, col decreases
            var udir = Math.random() < 0.5;
            var unr, unc;
            if (udir) { unr = e.row - 1; unc = e.col - 1; } // UL (up and left)
            else      { unr = e.row;     unc = e.col - 1; }  // Left (same row)
            if (isValidPos(unr, unc)) {
                e.row = unr; e.col = unc;
            } else {
                enemies.splice(i, 1);
                if (hasUggWrongway()) scheduleSpawn(12, 'ugg');
                continue;
            }
        } else if (e.type === 'wrongway') {
            // Arcade: Wrongway spawns bottom-left, moves toward top-right.
            // Can move UR (row-1,col) or stay same row move right (row,col+1)
            var wdir = Math.random() < 0.5;
            var wnr, wnc;
            if (wdir) { wnr = e.row - 1; wnc = e.col;     } // UR (up and right)
            else      { wnr = e.row;     wnc = e.col + 1;  } // Right (same row)
            if (isValidPos(wnr, wnc)) {
                e.row = wnr; e.col = wnc;
            } else {
                enemies.splice(i, 1);
                if (hasUggWrongway()) scheduleSpawn(14, 'wrongway');
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
                if (hasSlick()) scheduleSpawn(15, 'slick');
                continue;
            }
        }

        if (!player.dead && e.row === player.row && e.col === player.col) {
            if (e.type === 'slick') {
                score += 300; checkExtraLife();
                enemies.splice(i, 1);
            } else if (e.type === 'greenball') {
                score += 100; checkExtraLife();
                freezeTimer = 5;
                enemies.splice(i, 1);
            } else {
                killPlayer(e.type + ' moved onto @(' + e.row + ',' + e.col + ')');
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
            if (!noEnemies) {
                scheduleSpawn(7);
                if (hasRedBall())     scheduleSpawn(5, 'redball');
                if (hasSlick())       scheduleSpawn(13, 'slick');
                if (hasGreenBall())   scheduleSpawn(10, 'greenball');
                if (hasUggWrongway()) scheduleSpawn(12, 'ugg');
                if (hasUggWrongway()) scheduleSpawn(14, 'wrongway');
            }
        }
        return null;
    }

    var dir = computeAIMove();
    if (!dir) return null;

    if (!tryMove(dir)) return dir;

    if (!player.dead && allColored()) {
        score += roundCompletionBonus();
        score += unusedDiscBonus();
        checkExtraLife();
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
    round = startRound;
    score = 0;
    lives = 3;
    extraLifeGiven = 0;
    var totalDeaths = 0;
    var prevLives = lives;

    for (; round <= maxRounds; round++) {
        initRound();
        var moveNum = 0;
        var maxTurns = 200;

        if (verbose) {
            console.log('\n' + '='.repeat(50));
            console.log('LV ' + arcadeLevel() + ' ROUND ' + ((round - 1) % 4 + 1) + ' (target: ' + targetState() + ', lv' + arcadeLevel() + ')');
            console.log('='.repeat(50));
        }

        for (var turn = 0; turn < maxTurns; turn++) {
            var aiMove = simTurn();

            if (lives !== prevLives) {
                if (lives < prevLives) {
                    totalDeaths += prevLives - lives;
                    if (verbose) console.log('  Turn ' + turn + ': DIED! Lives=' + lives);
                }
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
                    if (noEnemies && moveNum % 10 === 0) console.log(drawBoard());
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
if (noEnemies) {
    // Disable precomputed tours so the AI uses search + tour cost heuristic
    PRECOMPUTED_TOURS = {};
}

console.log('Running ' + numRounds + ' rounds from round ' + startRound + (verbose ? ' (verbose)' : '') + '...\n');
var result = runGame(startRound + numRounds - 1, verbose);
console.log('\nFinal: rounds=' + result.rounds + ' score=' + result.score + ' deaths=' + result.deaths);
if (astarStats.solved + astarStats.fallbacks > 0) {
    console.log('A* stats: solved=' + astarStats.solved + ' fallbacks=' + astarStats.fallbacks +
        ' avgNodes=' + Math.round(astarStats.totalNodes / (astarStats.solved + astarStats.fallbacks)) +
        ' cacheHits=' + astarTourCacheHits + ' cacheMisses=' + astarTourCacheMisses);
}
