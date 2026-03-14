#!/usr/bin/env node
// Q*bert AI test harness — frame-based simulation using shared game engine
// Loads game logic from qbert.js and AI from qbert-ai.js

// ─── Load shared modules ────────────────────────────────────────────────────
var player, enemies, cubeStates, discs, round, score;
var aiTour, aiTourIdx, aiBoardSig, aiDetailPath, aiTourDots;
var astarStats = { solved: 0, fallbacks: 0, totalNodes: 0, cacheHits: 0 };
var astarTourCacheHits = 0, astarTourCacheMisses = 0;
var gameSpeed = 1.0;
var freezeTimer = 0;

eval(require('fs').readFileSync(__dirname + '/qbert.js', 'utf8'));
eval(require('fs').readFileSync(__dirname + '/qbert-ai.js', 'utf8'));

// Override AI time budget — node can afford more than browser's 16ms frame
AI_TIME_BUDGET = 50;
MC_SAMPLES = 32;
MC_DEPTH = 6;

// ─── Game state ─────────────────────────────────────────────────────────────
var lives, extraLifeGiven, levelWon, turnCount;
var frameCount;
var noEnemies = false;
var gs; // game state object

var deathLog = [];
function killPlayer(reason) {
    if (gs.player.dead) return;
    gs.player.dead = true;
    gs.player.deathTimer = 90;
    lives--;
    var hasCoily = false;
    for (var di = 0; di < gs.enemies.length; di++) if (gs.enemies[di].type === 'coily') { hasCoily = true; break; }
    deathLog.push({ reason: reason || 'unknown', row: gs.player.row, col: gs.player.col, round: round, mode: hasCoily ? 2 : 1 });
    if (verbose) console.log('  KILL: ' + (reason || 'unknown') + ' at (' + gs.player.row + ',' + gs.player.col + ') lives=' + lives + ' mode=' + (hasCoily ? 2 : 1));
}

function checkExtraLife() {
    var nextThreshold = extraLifeGiven ? (8000 + extraLifeGiven * 14000) : 8000;
    if (score >= nextThreshold) {
        extraLifeGiven = (extraLifeGiven || 0) + 1;
        lives++;
    }
}

// ─── Round initialization ───────────────────────────────────────────────────
function initRound() {
    gs = simCreateRoundState(round);
    // Set up convenience globals (AI code reads these)
    player = gs.player;
    enemies = gs.enemies;
    cubeStates = gs.cubes;
    discs = gs.discs;
    levelWon = false;
    turnCount = 0;
    frameCount = 0;
    freezeTimer = 0;
    aiDetailPath = []; aiTourDots = [];
    aiTour = []; aiTourIdx = 0; aiBoardSig = '';
    aiTourInit();

    if (!noEnemies) {
        simScheduleInitialEnemies(gs);
    }
}

// ─── AI move computation ────────────────────────────────────────────────────
function computeAIMove() {
    var bestDir = aiPickBestDir();
    if (boardSig() !== aiBoardSig || aiTour.length === 0) buildTour();
    return bestDir;
}

// ─── Main frame loop ────────────────────────────────────────────────────────
function simFrame() {
    if (levelWon) return null;
    frameCount++;

    // Update game state using shared simulation
    var playerResult = simUpdatePlayer(gs);
    simUpdateEnemies(gs);

    // Sync freezeTimer for AI access
    freezeTimer = gs.freezeTimer;

    // Per-frame collision (arcade model: same tile = death)
    simCheckCollision(gs);

    // Handle player death
    if (gs.player.dead && gs.alive === false) {
        // First frame of death — log it
        gs.alive = true; // reset for next check
        gs.player.deathTimer = 90;
        killPlayer((gs.deathEnemy || 'unknown') + ' collision @(' + gs.player.row + ',' + gs.player.col + ')');
        gs.deathEnemy = null;
        score += gs.score; gs.score = 0;
    }

    // Handle respawn
    if (playerResult === 'respawn' && lives > 0) {
        gs.player.dead = false;
        gs.player.row = 0; gs.player.col = 0;
        gs.player.jumping = false;
        simStompCube(gs, 0, 0);
        // Clear all non-spawn-timer enemies
        var kept = [];
        for (var i = 0; i < gs.enemies.length; i++)
            if (gs.enemies[i].type === 'spawn-timer') kept.push(gs.enemies[i]);
        gs.enemies = kept;
        enemies = gs.enemies; // update convenience global
        if (!noEnemies) simScheduleRespawnEnemies(gs);
    }

    // Handle player landing
    if (playerResult === 'landed') {
        simStompCube(gs, gs.player.row, gs.player.col);
        // Track scoring
        score += gs.score; gs.score = 0;
        checkExtraLife();
        // Check collision on landing
        simCheckCollision(gs);
        if (gs.player.dead && gs.alive === false) {
            gs.alive = true;
            gs.player.deathTimer = 90;
            killPlayer((gs.deathEnemy || 'unknown') + ' collision @(' + gs.player.row + ',' + gs.player.col + ')');
            gs.deathEnemy = null;
        }
        // Check level complete
        if (!gs.player.dead && simAllColored(gs)) {
            score += roundCompletionBonus();
            score += unusedDiscBonus(gs.discs);
            checkExtraLife();
            levelWon = true;
        }
    }

    // Sync score from sim
    if (gs.score !== 0) { score += gs.score; gs.score = 0; checkExtraLife(); }

    // AI input: when player is ready
    if (!gs.player.jumping && !gs.player.dead && !levelWon) {
        var dir = computeAIMove();
        if (dir && dir !== 'STAY') {
            simTryMove(gs, dir);
            enemies = gs.enemies; // array may have changed (disc use)
            return dir;
        }
        return dir === 'STAY' ? 'STAY' : null;
    }
    return null;
}

// ─── Visualization helpers ──────────────────────────────────────────────────
function countRemaining() {
    var tgt = targetState();
    var n = 0;
    for (var i = 0; i < gs.cubes.length; i++)
        if (gs.cubes[i].state < tgt) n++;
    return n;
}

function enemySummary() {
    var parts = [];
    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type === 'spawn-timer') { parts.push('spawn(' + e.timer + ')'); continue; }
        parts.push(e.type + '@(' + e.row + ',' + e.col + ')');
    }
    return parts.length ? parts.join(' ') : 'none';
}

// ─── Run simulation ─────────────────────────────────────────────────────────
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
        var maxFrames = 200 * 60;

        if (verbose) {
            console.log('\n' + '='.repeat(50));
            console.log('LV ' + arcadeLevel() + ' ROUND ' + ((round - 1) % 4 + 1) + ' (target: ' + targetState() + ', lv' + arcadeLevel() + ')');
            console.log('='.repeat(50));
        }

        for (var frame = 0; frame < maxFrames; frame++) {
            var aiMove = simFrame();

            if (lives !== prevLives) {
                if (lives < prevLives) totalDeaths += prevLives - lives;
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
                    var tc = mstTourCost(posToIdx[gs.player.row * ROWS + gs.player.col], gs.cubes, targetState(), arcadeLevel());
                    var extra = '';
                    if (remaining <= 5) {
                        var tgt = targetState();
                        var uncolored = [];
                        for (var ci = 0; ci < gs.cubes.length; ci++)
                            if (gs.cubes[ci].state < tgt) uncolored.push('(' + gs.cubes[ci].row + ',' + gs.cubes[ci].col + ')');
                        extra = '  need=' + uncolored.join(',');
                    }
                    console.log('  #' + moveNum + ' ' + aiMove +
                        ' -> (' + gs.player.row + ',' + gs.player.col + ')  left=' + remaining +
                        '  h=' + tc +
                        (gs.enemies.length > 0 ? '  enemies: ' + enemySummary() : '') + extra);
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

// ─── Main ───────────────────────────────────────────────────────────────────
var verbose = process.argv.includes('-v') || process.argv.includes('--verbose');
noEnemies = process.argv.includes('--no-enemies');
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
if (deathLog.length > 0) {
    var byType = {}, byRow = {};
    for (var di = 0; di < deathLog.length; di++) {
        var dl = deathLog[di];
        var t = dl.reason.split(' ')[0];
        byType[t] = (byType[t] || 0) + 1;
        byRow[dl.row] = (byRow[dl.row] || 0) + 1;
    }
    console.log('Deaths by cause: ' + JSON.stringify(byType));
    console.log('Deaths by row: ' + JSON.stringify(byRow));
}
