#!/usr/bin/env node
// CMA-ES (Covariance Matrix Adaptation Evolution Strategy) headless trainer
// for the Chrome Dino runner game.
//
// Replicates game physics in pure Node.js (no browser needed).
// Outputs trained weights as JSON for autoloading in the game.

'use strict';

var fs = require('fs');

// ═══════════════════════════════════════════════════════════════════════════
// Game constants — exact copy from runner.js
// ═══════════════════════════════════════════════════════════════════════════
var FPS = 60;
var DEFAULT_WIDTH = 700;
var GAME_HEIGHT = 150;
var BOTTOM_PAD = 10;
var ACCELERATION = 0.002;
var START_SPEED = 6;
var MAX_SPEED = 13;  // Real game cap
var CLEAR_TIME = 3000;
var GAP_COEFFICIENT = 0.6;
var MAX_GAP_COEFFICIENT = 1.5;
var MAX_OBSTACLE_LENGTH = 3;
var MAX_OBSTACLE_DUPLICATION = 2;

// Trex config
var TREX_WIDTH = 44;
var TREX_HEIGHT = 47;
var TREX_HEIGHT_DUCK = 25;
var TREX_WIDTH_DUCK = 59;
var TREX_START_X = 50;
var DROP_VELOCITY = -5;
var GRAVITY = 0.6;
var INITIAL_JUMP_VELOCITY = -10;
var MAX_JUMP_HEIGHT = 30;
var MIN_JUMP_HEIGHT = 30;
var SPEED_DROP_COEFFICIENT = 3;

var GROUND_Y = GAME_HEIGHT - TREX_HEIGHT - BOTTOM_PAD; // 93

// Collision boxes
var TREX_CB_RUNNING = [
    { x: 22, y: 0, width: 17, height: 16 },
    { x: 1, y: 18, width: 30, height: 9 },
    { x: 10, y: 35, width: 14, height: 8 },
    { x: 1, y: 24, width: 29, height: 5 },
    { x: 5, y: 30, width: 21, height: 4 },
    { x: 9, y: 34, width: 15, height: 4 }
];
var TREX_CB_DUCKING = [
    { x: 1, y: 18, width: 55, height: 25 }
];

// Obstacle types
var OBSTACLE_TYPES = [
    {
        type: 'CACTUS_SMALL', width: 17, height: 35, yPos: 105,
        multipleSpeed: 4, minGap: 120, minSpeed: 0, speedOffset: 0,
        collisionBoxes: [
            { x: 0, y: 7, width: 5, height: 27 },
            { x: 4, y: 0, width: 6, height: 34 },
            { x: 10, y: 4, width: 7, height: 14 }
        ]
    },
    {
        type: 'CACTUS_LARGE', width: 25, height: 50, yPos: 90,
        multipleSpeed: 7, minGap: 120, minSpeed: 0, speedOffset: 0,
        collisionBoxes: [
            { x: 0, y: 12, width: 7, height: 38 },
            { x: 8, y: 0, width: 7, height: 49 },
            { x: 13, y: 10, width: 10, height: 38 }
        ]
    },
    {
        type: 'PTERODACTYL', width: 46, height: 40,
        yPos: [100, 75, 50],
        multipleSpeed: 999, minGap: 150, minSpeed: 8.5, speedOffset: 0.8,
        collisionBoxes: [
            { x: 15, y: 15, width: 16, height: 5 },
            { x: 18, y: 21, width: 24, height: 6 },
            { x: 2, y: 14, width: 4, height: 3 },
            { x: 6, y: 10, width: 4, height: 7 },
            { x: 10, y: 8, width: 6, height: 9 }
        ]
    }
];

// ═══════════════════════════════════════════════════════════════════════════
// Game simulation
// ═══════════════════════════════════════════════════════════════════════════

function getRandomNum(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createTrex() {
    return {
        xPos: TREX_START_X,
        yPos: GROUND_Y,
        groundYPos: GROUND_Y,
        minJumpHeight: GROUND_Y - MIN_JUMP_HEIGHT,
        jumping: false,
        ducking: false,
        jumpVelocity: 0,
        reachedMinHeight: false,
        speedDrop: false
    };
}

function trexStartJump(t, speed) {
    if (!t.jumping) {
        t.jumpVelocity = INITIAL_JUMP_VELOCITY - (speed / 10);
        t.jumping = true;
        t.reachedMinHeight = false;
        t.speedDrop = false;
    }
}

function trexUpdateJump(t, deltaTime) {
    var msPerFrame = 1000 / FPS; // JUMPING msPerFrame
    var framesElapsed = deltaTime / msPerFrame;

    if (t.speedDrop) {
        t.yPos += Math.round(t.jumpVelocity * SPEED_DROP_COEFFICIENT * framesElapsed);
    } else {
        t.yPos += Math.round(t.jumpVelocity * framesElapsed);
    }

    t.jumpVelocity += GRAVITY * framesElapsed;

    if (t.yPos < t.minJumpHeight || t.speedDrop) {
        t.reachedMinHeight = true;
    }

    if (t.yPos < MAX_JUMP_HEIGHT || t.speedDrop) {
        // endJump
        if (t.reachedMinHeight && t.jumpVelocity < DROP_VELOCITY) {
            t.jumpVelocity = DROP_VELOCITY;
        }
    }

    if (t.yPos >= t.groundYPos) {
        var wasSpeedDrop = t.speedDrop;
        // reset
        t.yPos = t.groundYPos;
        t.jumpVelocity = 0;
        t.jumping = false;
        t.speedDrop = false;
        t.ducking = false;
        t.reachedMinHeight = false;
        if (wasSpeedDrop) {
            t.ducking = true;
        }
    }
}

function trexSetSpeedDrop(t) {
    t.speedDrop = true;
    t.jumpVelocity = 1;
}

function trexSetDuck(t, isDucking) {
    if (isDucking) {
        t.ducking = true;
    } else {
        t.ducking = false;
    }
}

function createObstacle(typeConfig, speed, dimensions) {
    var size = getRandomNum(1, MAX_OBSTACLE_LENGTH);
    if (size > 1 && typeConfig.multipleSpeed > speed) {
        size = 1;
    }

    var yPos;
    if (Array.isArray(typeConfig.yPos)) {
        yPos = typeConfig.yPos[getRandomNum(0, typeConfig.yPos.length - 1)];
    } else {
        yPos = typeConfig.yPos;
    }

    var width = typeConfig.width * size;

    // Clone collision boxes
    var collisionBoxes = [];
    for (var i = 0; i < typeConfig.collisionBoxes.length; i++) {
        var cb = typeConfig.collisionBoxes[i];
        collisionBoxes.push({ x: cb.x, y: cb.y, width: cb.width, height: cb.height });
    }

    // Adjust collision boxes for multi-size
    if (size > 1) {
        collisionBoxes[1].width = width - collisionBoxes[0].width - collisionBoxes[2].width;
        collisionBoxes[2].x = width - collisionBoxes[2].width;
    }

    var speedOffset = 0;
    if (typeConfig.speedOffset) {
        speedOffset = Math.random() > 0.5 ? typeConfig.speedOffset : -typeConfig.speedOffset;
    }

    // Gap calculation
    var minGap = Math.round(width * speed + typeConfig.minGap * GAP_COEFFICIENT);
    var maxGap = Math.round(minGap * MAX_GAP_COEFFICIENT);
    var gap = getRandomNum(minGap, maxGap);

    return {
        typeConfig: typeConfig,
        xPos: dimensions.WIDTH + typeConfig.width, // opt_xOffset = typeConfig.width
        yPos: yPos,
        width: width,
        size: size,
        gap: gap,
        speedOffset: speedOffset,
        collisionBoxes: collisionBoxes,
        remove: false,
        followingObstacleCreated: false
    };
}

function createGame() {
    return {
        tRex: createTrex(),
        obstacles: [],
        obstacleHistory: [],
        currentSpeed: START_SPEED,
        distanceRan: 0,
        runningTime: 0,
        dimensions: { WIDTH: DEFAULT_WIDTH, HEIGHT: GAME_HEIGHT },
        msPerFrame: 1000 / FPS
    };
}

function addNewObstacle(game) {
    var typeIndex = getRandomNum(0, OBSTACLE_TYPES.length - 1);
    var type = OBSTACLE_TYPES[typeIndex];

    // Duplicate check
    var dupCount = 0;
    for (var i = 0; i < game.obstacleHistory.length; i++) {
        dupCount = game.obstacleHistory[i] === type.type ? dupCount + 1 : 0;
    }
    if (dupCount >= MAX_OBSTACLE_DUPLICATION || game.currentSpeed < type.minSpeed) {
        addNewObstacle(game);
        return;
    }

    game.obstacles.push(createObstacle(type, game.currentSpeed, game.dimensions));
    game.obstacleHistory.unshift(type.type);
    if (game.obstacleHistory.length > 1) {
        game.obstacleHistory.splice(MAX_OBSTACLE_DUPLICATION);
    }
}

function boxCompare(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x &&
           a.y < b.y + b.height && a.y + a.height > b.y;
}

function createAdjustedBox(cb, entityBox) {
    return {
        x: entityBox.x + cb.x,
        y: entityBox.y + cb.y,
        width: cb.width,
        height: cb.height
    };
}

function gameStep(game, action) {
    var deltaTime = 1000 / FPS;
    var t = game.tRex;

    // Apply action
    if (action === 1 && !t.jumping) {
        if (t.ducking) trexSetDuck(t, false);
        trexStartJump(t, game.currentSpeed);
    } else if (action === 2) {
        if (t.jumping) {
            if (!t.speedDrop) trexSetSpeedDrop(t);
        } else {
            if (!t.ducking) trexSetDuck(t, true);
        }
    } else if (action === 0) {
        if (t.ducking && !t.jumping) trexSetDuck(t, false);
    }

    // Update jump physics
    if (t.jumping) trexUpdateJump(t, deltaTime);

    // Speed-drop becomes duck on landing
    if (t.speedDrop && t.yPos === t.groundYPos) {
        t.speedDrop = false;
        trexSetDuck(t, true);
    }

    game.runningTime += deltaTime;
    var hasObstacles = game.runningTime > CLEAR_TIME;

    // Update obstacles
    if (hasObstacles) {
        // Move obstacles
        for (var i = game.obstacles.length - 1; i >= 0; i--) {
            var obs = game.obstacles[i];
            var speed = game.currentSpeed;
            if (obs.speedOffset) speed += obs.speedOffset;
            obs.xPos -= Math.floor((speed * FPS / 1000) * deltaTime);
            if (obs.xPos + obs.width <= 0) {
                game.obstacles.splice(i, 1);
            }
        }

        // Spawn new obstacles
        if (game.obstacles.length > 0) {
            var last = game.obstacles[game.obstacles.length - 1];
            if (!last.followingObstacleCreated &&
                (last.xPos + last.width > 0) &&
                (last.xPos + last.width + last.gap) < game.dimensions.WIDTH) {
                addNewObstacle(game);
                last.followingObstacleCreated = true;
            }
        } else {
            addNewObstacle(game);
        }
    }

    // Collision detection — matches runner.js exactly:
    // Outer box always uses full WIDTH/HEIGHT regardless of ducking.
    // Ducking is handled by the DUCKING collision boxes being offset.
    var collision = false;
    if (hasObstacles && game.obstacles.length > 0) {
        var obs = game.obstacles[0];

        var tRexBox = { x: t.xPos + 1, y: t.yPos + 1,
                        width: TREX_WIDTH - 2, height: TREX_HEIGHT - 2 };
        var obstacleBox = {
            x: obs.xPos + 1, y: obs.yPos + 1,
            width: obs.typeConfig.width * obs.size - 2,
            height: obs.typeConfig.height - 2
        };

        if (boxCompare(tRexBox, obstacleBox)) {
            var tRexCB = t.ducking ? TREX_CB_DUCKING : TREX_CB_RUNNING;
            for (var ti = 0; ti < tRexCB.length && !collision; ti++) {
                for (var oi = 0; oi < obs.collisionBoxes.length && !collision; oi++) {
                    if (boxCompare(
                        createAdjustedBox(tRexCB[ti], tRexBox),
                        createAdjustedBox(obs.collisionBoxes[oi], obstacleBox))) {
                        collision = true;
                    }
                }
            }
        }
    }

    if (!collision) {
        game.distanceRan += game.currentSpeed * deltaTime / game.msPerFrame;
        if (game.currentSpeed < MAX_SPEED) {
            game.currentSpeed += ACCELERATION;
        }
    }

    return collision;
}

// ═══════════════════════════════════════════════════════════════════════════
// State extraction — matches mlExtractState in dino-runner.html
// ═══════════════════════════════════════════════════════════════════════════

function extractState(game) {
    var t = game.tRex;
    var obstacles = game.obstacles;
    var CW = game.dimensions.WIDTH;

    var sorted = [];
    for (var i = 0; i < obstacles.length; i++) {
        if (obstacles[i].xPos + obstacles[i].width > t.xPos)
            sorted.push(obstacles[i]);
    }
    sorted.sort(function (a, b) { return a.xPos - b.xPos; });

    var obs1Dist = 1, obs1Y = 0, obs1Type = 0, obs1H = 0, obs1W = 0, obs2Dist = 1;
    if (sorted.length > 0) {
        var o = sorted[0];
        obs1Dist = Math.max(0, o.xPos - t.xPos) / CW;
        obs1Y = o.yPos / 150;
        obs1Type = (o.typeConfig && o.typeConfig.type === 'PTERODACTYL') ? 1 : 0;
        obs1H = (o.typeConfig ? o.typeConfig.height : 35) / 60;
        obs1W = (o.width || 25) / 150;
    }
    if (sorted.length > 1) {
        obs2Dist = Math.max(0, sorted[1].xPos - t.xPos) / CW;
    }
    var jumpHeight = t.jumping ? (t.groundYPos - t.yPos) / 80 : 0;
    var jumpVel = t.jumping ? t.jumpVelocity / 10 : 0;
    return [obs1Dist, obs1Y, obs1Type, obs1H, obs1W, obs2Dist,
            (game.currentSpeed - 6) / 44, jumpHeight, jumpVel, t.ducking ? 1 : 0];
}

// ═══════════════════════════════════════════════════════════════════════════
// Neural network — same architecture as neuroevolution section (10→16→3)
// ═══════════════════════════════════════════════════════════════════════════

var N_IN = 10, N_HID = 16, N_OUT = 3;
var GENOME_LEN = (N_IN + 1) * N_HID + (N_HID + 1) * N_OUT; // 227

function nnForward(g, input) {
    var h = new Float64Array(N_HID);
    for (var j = 0; j < N_HID; j++) {
        var sum = 0;
        for (var i = 0; i < N_IN; i++) sum += input[i] * g[i * N_HID + j];
        sum += g[N_IN * N_HID + j]; // bias
        h[j] = sum > 0 ? sum : 0; // ReLU
    }
    var oOff = N_IN * N_HID + N_HID;
    var o = new Float64Array(N_OUT);
    for (var j = 0; j < N_OUT; j++) {
        var sum = 0;
        for (var i = 0; i < N_HID; i++) sum += h[i] * g[oOff + i * N_OUT + j];
        sum += g[oOff + N_HID * N_OUT + j];
        o[j] = sum;
    }
    return o;
}

function nnAction(g, input) {
    var o = nnForward(g, input);
    var best = 0;
    if (o[1] > o[best]) best = 1;
    if (o[2] > o[best]) best = 2;
    return best;
}

// ═══════════════════════════════════════════════════════════════════════════
// Fitness evaluation — run a game and return score
// ═══════════════════════════════════════════════════════════════════════════

var MAX_FRAMES = 30000; // ~8 minutes at 60fps, score ~12500

function evaluateGenome(genome) {
    var game = createGame();
    for (var frame = 0; frame < MAX_FRAMES; frame++) {
        var state = extractState(game);
        var action = nnAction(genome, state);
        var collision = gameStep(game, action);
        if (collision) break;
    }
    return Math.round(game.distanceRan * 0.025);
}

// Average over multiple runs for more stable fitness
function evaluateGenomeAvg(genome, nRuns) {
    var total = 0;
    for (var i = 0; i < nRuns; i++) {
        total += evaluateGenome(genome);
    }
    return total / nRuns;
}

// ═══════════════════════════════════════════════════════════════════════════
// Evolution Strategy — simple (μ+λ)-ES with elitism
// Proven to work for this problem; much more noise-robust than CMA-ES.
// ═══════════════════════════════════════════════════════════════════════════

function randn() {
    return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

function createGenome() {
    var g = new Float64Array(GENOME_LEN);
    var s1 = Math.sqrt(2 / N_IN), s2 = Math.sqrt(2 / N_HID);
    var k = 0;
    for (var i = 0; i < N_IN * N_HID; i++) g[k++] = randn() * s1;
    for (var i = 0; i < N_HID; i++) g[k++] = 0;
    for (var i = 0; i < N_HID * N_OUT; i++) g[k++] = randn() * s2;
    for (var i = 0; i < N_OUT; i++) g[k++] = 0;
    return g;
}

function crossover(a, b) {
    var child = new Float64Array(a.length);
    for (var i = 0; i < a.length; i++) child[i] = Math.random() < 0.5 ? a[i] : b[i];
    return child;
}

function mutate(parent, sigma) {
    var child = new Float64Array(parent.length);
    for (var i = 0; i < parent.length; i++) child[i] = parent[i] + randn() * sigma;
    return child;
}

// ═══════════════════════════════════════════════════════════════════════════
// Training loop
// ═══════════════════════════════════════════════════════════════════════════

var POP_SIZE = 120;
var ELITE_SIZE = 20;
var SIGMA_START = 0.4;
var SIGMA_MIN = 0.05;
var SIGMA_DECAY = 0.997;
var MAX_GENERATIONS = 3000;
var TARGET_SCORE = 2000; // Target for MINIMUM across 5 runs (ensures robustness)

function train() {
    console.log('ES Training for Dino Runner');
    console.log('Network: ' + N_IN + ' → ' + N_HID + ' → ' + N_OUT +
                ' (' + GENOME_LEN + ' params)');
    console.log('Population: ' + POP_SIZE + ', Elite: ' + ELITE_SIZE);
    console.log('');

    // Initialize population — seed from saved weights if available
    var population = [];
    var bestEverScore = 0;
    var bestEverGenome = null;

    try {
        var saved = JSON.parse(fs.readFileSync('dino-cmaes-best.json', 'utf8'));
        if (saved.genome && saved.genome.length === GENOME_LEN) {
            bestEverGenome = new Float64Array(saved.genome);
            // Don't restore bestEverScore — let it be re-evaluated
            console.log('Loaded saved weights — seeding population');
            // Seed population from saved genome
            population.push({ genome: new Float64Array(bestEverGenome), fitness: 0 });
            for (var i = 1; i < POP_SIZE; i++) {
                population.push({ genome: mutate(bestEverGenome, SIGMA_START * 0.25), fitness: 0 });
            }
        }
    } catch (e) { /* no saved weights */ }

    if (population.length === 0) {
        for (var i = 0; i < POP_SIZE; i++) {
            population.push({ genome: createGenome(), fitness: 0 });
        }
    }
    var sigma = SIGMA_START;
    var stagnation = 0;
    var scoreHistory = [];

    for (var gen = 0; gen < MAX_GENERATIONS; gen++) {
        // Evaluate each individual — use minimum of 5 runs for robustness
        var EVALS = 5;
        var genBest = 0;
        var genTotal = 0;
        for (var k = 0; k < POP_SIZE; k++) {
            var minScore = Infinity;
            for (var e = 0; e < EVALS; e++) {
                var s = evaluateGenome(population[k].genome);
                if (s < minScore) minScore = s;
            }
            population[k].fitness = minScore;
            if (population[k].fitness > genBest) genBest = population[k].fitness;
            genTotal += population[k].fitness;
        }
        var genAvg = genTotal / POP_SIZE;

        // Sort by fitness (descending)
        population.sort(function (a, b) { return b.fitness - a.fitness; });

        scoreHistory.push(genBest);

        if (genBest > bestEverScore) {
            bestEverScore = genBest;
            bestEverGenome = new Float64Array(population[0].genome);
            stagnation = 0;
        } else {
            stagnation++;
        }

        // Adaptive sigma: decay normally, boost on stagnation
        sigma = Math.max(SIGMA_MIN, sigma * SIGMA_DECAY);
        if (stagnation > 20 && stagnation % 10 === 0) {
            sigma = Math.min(SIGMA_START * 2, sigma * 3);
        }

        // Progress output
        if ((gen + 1) % 10 === 0 || genBest >= bestEverScore) {
            console.log('Gen ' + (gen + 1).toString().padStart(4) +
                ' | Best: ' + genBest.toString().padStart(6) +
                ' | Avg: ' + Math.round(genAvg).toString().padStart(6) +
                ' | σ: ' + sigma.toFixed(4) +
                ' | All-time: ' + bestEverScore);
        }

        // Save checkpoint every 50 generations
        if ((gen + 1) % 50 === 0) {
            saveWeights(bestEverGenome || population[0].genome, bestEverScore, gen + 1, scoreHistory);
        }

        // Early stop — require high generation best (min-of-5) AND high average
        // Use genBest (this generation), not bestEverScore (may be from lucky old run)
        if (genBest >= TARGET_SCORE && genAvg >= 1200 && gen >= 10) {
            // Verify robustness: test the best genome over 20 runs
            var verifyScores = [];
            for (var v = 0; v < 20; v++) verifyScores.push(evaluateGenome(population[0].genome));
            verifyScores.sort(function(a,b){return a-b;});
            var verifyMin = verifyScores[0];
            var verifyMedian = verifyScores[10];
            console.log('\nVerifying best genome (20 runs): min=' + verifyMin + ' median=' + verifyMedian);
            if (verifyMedian >= 2000 && verifyMin >= 500) {
                console.log('Target reached! GenBest: ' + genBest + ', Avg: ' + Math.round(genAvg));
                break;
            } else {
                console.log('Verification failed — continuing training');
            }
        }

        // Create next generation
        var newPop = [];

        // Keep elite unchanged
        for (var e = 0; e < ELITE_SIZE; e++) {
            newPop.push({ genome: population[e].genome, fitness: 0 });
        }

        // Also ensure best-ever is always in the population
        if (bestEverGenome) {
            newPop.push({ genome: new Float64Array(bestEverGenome), fitness: 0 });
        }

        // Fill rest via mutation and crossover from elite parents
        while (newPop.length < POP_SIZE) {
            var p1 = Math.floor(Math.random() * ELITE_SIZE);
            var p2 = Math.floor(Math.random() * ELITE_SIZE);
            var base;
            if (p1 !== p2 && Math.random() < 0.5) {
                base = crossover(population[p1].genome, population[p2].genome);
            } else {
                base = population[p1].genome;
            }
            newPop.push({ genome: mutate(base, sigma), fitness: 0 });
        }
        population = newPop;
    }

    // Final evaluation — test the best genome 20 times
    console.log('\n--- Final Evaluation (20 games) ---');
    var finalGenome = bestEverGenome || population[0].genome;
    var scores = [];
    for (var i = 0; i < 20; i++) {
        var score = evaluateGenome(finalGenome);
        scores.push(score);
    }
    scores.sort(function (a, b) { return a - b; });
    var sum = 0;
    for (var i = 0; i < scores.length; i++) sum += scores[i];
    var avg = sum / scores.length;
    var median = scores[Math.floor(scores.length / 2)];
    var min = scores[0], max = scores[scores.length - 1];
    console.log('Scores: ' + scores.join(', '));
    console.log('Avg: ' + Math.round(avg) + ' | Median: ' + median +
                ' | Min: ' + min + ' | Max: ' + max);

    saveWeights(finalGenome, bestEverScore, gen + 1, scoreHistory);

    return { genome: finalGenome, avgScore: avg, bestScore: bestEverScore };
}

function saveWeights(genome, bestScore, generation, scoreHistory) {
    // Save in format compatible with the neuroevolution section's nnForward
    var data = {
        architecture: [N_IN, N_HID, N_OUT],
        genomeLength: GENOME_LEN,
        genome: Array.from(genome),
        bestScore: bestScore,
        generation: generation,
        method: 'Evolution Strategy (μ+λ)-ES',
        scoreHistory: scoreHistory || []
    };

    fs.writeFileSync('dino-cmaes-best.json', JSON.stringify(data));
    console.log('  → Saved dino-cmaes-best.json (best score: ' + bestScore + ')');
}

// Export for testing
if (typeof module !== 'undefined') {
    module.exports = {
        createGame: createGame, gameStep: gameStep, extractState: extractState,
        nnForward: nnForward, nnAction: nnAction, evaluateGenome: evaluateGenome,
        N_IN: N_IN, N_HID: N_HID, N_OUT: N_OUT, GENOME_LEN: GENOME_LEN
    };
}

// Run if executed directly
if (require.main === module) {
    var result = train();
    console.log('\nDone! Best genome saved to dino-cmaes-best.json');
    process.exit(0);
}
