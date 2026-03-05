/**
 * rl-agent.js — Neuroevolution agent for the Chrome Dino game.
 * Pure JavaScript, no external libraries.
 *
 * Architecture: Population of 50 small networks (10 -> 16 ReLU -> 3 argmax).
 * Training: Evolutionary strategy — tournament selection, Gaussian mutation,
 * elitism. No gradients, no backprop.
 */

(function () {
    'use strict';

    // =========================================================================
    // Neural Network — Minimal feedforward net for neuroevolution
    // =========================================================================

    /** Standard normal random via Box-Muller. */
    function randn() {
        var u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }

    /**
     * Create weight matrices and bias vectors for the given layer sizes.
     * Uses He initialization: W ~ N(0, sqrt(2/fan_in)).
     * @param {Array<number>} sizes e.g. [10, 16, 3]
     * @return {Object} { layers: [{W, b, rows, cols}], sizes }
     */
    function createNetwork(sizes) {
        var layers = [];
        for (var i = 0; i < sizes.length - 1; i++) {
            var fanIn = sizes[i];
            var fanOut = sizes[i + 1];
            var scale = Math.sqrt(2.0 / fanIn);
            var W = new Float64Array(fanOut * fanIn);
            var b = new Float64Array(fanOut);
            for (var j = 0; j < W.length; j++) {
                W[j] = randn() * scale;
            }
            layers.push({ W: W, b: b, rows: fanOut, cols: fanIn });
        }
        return { layers: layers, sizes: sizes };
    }

    /**
     * Deep-clone a network (new typed arrays, same values).
     */
    function cloneNetwork(net) {
        var layers = [];
        for (var i = 0; i < net.layers.length; i++) {
            var L = net.layers[i];
            layers.push({
                W: new Float64Array(L.W),
                b: new Float64Array(L.b),
                rows: L.rows,
                cols: L.cols
            });
        }
        return { layers: layers, sizes: net.sizes.slice() };
    }

    /**
     * Mutate a network in place by adding Gaussian noise.
     * @param {Object} net Network to mutate.
     * @param {number} sigma Standard deviation of noise.
     */
    function mutateNetwork(net, sigma) {
        for (var i = 0; i < net.layers.length; i++) {
            var L = net.layers[i];
            for (var j = 0; j < L.W.length; j++) {
                L.W[j] += randn() * sigma;
            }
            for (var j = 0; j < L.b.length; j++) {
                L.b[j] += randn() * sigma;
            }
        }
    }

    /**
     * Crossover: create a child by uniformly mixing two parent networks.
     * Each weight is randomly chosen from parent1 or parent2.
     */
    function crossoverNetworks(parent1, parent2) {
        var child = cloneNetwork(parent1);
        for (var i = 0; i < child.layers.length; i++) {
            var cL = child.layers[i];
            var p2L = parent2.layers[i];
            for (var j = 0; j < cL.W.length; j++) {
                if (Math.random() < 0.5) cL.W[j] = p2L.W[j];
            }
            for (var j = 0; j < cL.b.length; j++) {
                if (Math.random() < 0.5) cL.b[j] = p2L.b[j];
            }
        }
        return child;
    }

    /** Matrix-vector multiply: out = W * x + b */
    function matVecMul(W, x, b, rows, cols) {
        var out = new Float64Array(rows);
        for (var r = 0; r < rows; r++) {
            var sum = b[r];
            var offset = r * cols;
            for (var c = 0; c < cols; c++) {
                sum += W[offset + c] * x[c];
            }
            out[r] = sum;
        }
        return out;
    }

    /** In-place ReLU. */
    function relu(x) {
        for (var i = 0; i < x.length; i++) {
            if (x[i] < 0) x[i] = 0;
        }
    }

    /**
     * Forward pass — returns raw output values (no softmax; we use argmax).
     * Hidden layers use ReLU. Output layer is linear.
     * @param {Float64Array} input State vector.
     * @param {Object} net Network object from createNetwork.
     * @return {Float64Array} Output vector (3 action scores).
     */
    function forward(input, net) {
        var x = input;
        for (var i = 0; i < net.layers.length; i++) {
            var L = net.layers[i];
            var y = matVecMul(L.W, x, L.b, L.rows, L.cols);
            if (i < net.layers.length - 1) {
                relu(y);
            }
            x = y;
        }
        return x;
    }

    /**
     * Forward pass returning all layer activations for visualization.
     * Returns array: [input(12), hidden(20), output(3)]
     */
    function forwardWithActivations(input, net) {
        var activations = [input];
        var x = input;
        for (var i = 0; i < net.layers.length; i++) {
            var L = net.layers[i];
            var y = matVecMul(L.W, x, L.b, L.rows, L.cols);
            if (i < net.layers.length - 1) {
                relu(y);
            }
            activations.push(new Float64Array(y));
            x = y;
        }
        return activations;
    }

    /**
     * Count total parameters in a network.
     */
    function countParams(net) {
        var total = 0;
        for (var i = 0; i < net.layers.length; i++) {
            total += net.layers[i].W.length + net.layers[i].b.length;
        }
        return total;
    }

    // =========================================================================
    // Neuroevolution Constants
    // =========================================================================

    var LAYER_SIZES = [12, 20, 3];
    var NUM_ACTIONS = 3;         // 0=run, 1=jump, 2=duck
    var RL_NET_VERSION = 2;      // bump when architecture changes to invalidate old saves
    var POPULATION_SIZE = 50;
    var NUM_PARENTS = 10;        // top N selected as parents
    var NUM_ELITE = 5;           // top N copied unchanged to next gen
    // Default evolution constants — used as initial values.
    // These are copied to instance properties on RLAgent so they can be
    // tuned at runtime via UI sliders.
    var SIGMA_START_DEFAULT = 0.3;
    var SIGMA_MIN_DEFAULT = 0.08;
    var SIGMA_DECAY_DEFAULT = 0.998;
    var STAGNATION_GENS_DEFAULT = 9999;
    var MAX_SCORE_CAP_DEFAULT = 5000;
    var DECISION_ZONE_BASE = 300; // only use NN within this distance (scaled by speed)

    // =========================================================================
    // RL Agent — Neuroevolution
    // =========================================================================

    function RLAgent() {
        this.enabled = false;

        // --- Tunable evolution parameters (exposed to UI sliders) ---
        this.sigmaStart = SIGMA_START_DEFAULT;
        this.sigmaMin = SIGMA_MIN_DEFAULT;
        this.sigmaDecay = SIGMA_DECAY_DEFAULT;
        this.stagnationGens = STAGNATION_GENS_DEFAULT;
        this.maxScoreCap = MAX_SCORE_CAP_DEFAULT;

        // --- Evolution state ---
        this.generation = 0;
        this.sigma = this.sigmaStart;
        this.bestScore = 0;
        this._prevBestScore = 0;     // snapshot for stagnation detection
        this._gensSinceImprove = 0;  // stagnation counter

        // Population: array of {net, fitness}
        this.population = [];
        for (var i = 0; i < POPULATION_SIZE; i++) {
            this.population.push({
                net: createNetwork(LAYER_SIZES),
                fitness: 0
            });
        }

        // Index of current individual being evaluated (legacy sequential mode)
        this.currentIndividual = 0;

        // --- Parallel evaluation state ---
        this.parallelMode = true;   // default to parallel
        this.ghosts = [];           // GhostTrex instances (created when training starts)
        this._ghostsInitialized = false;
        this._globalFrame = 0;     // frame counter for animation
        this._aliveCount = 0;

        // History: best fitness per generation (for chart)
        this.generationBestHistory = [];

        // Snapshots: best network from each generation (for replay)
        this.generationSnapshots = [];

        // Per-episode tracking
        this.episodeScore = 0;
        this.totalSteps = 0;

        // Speed multiplier
        this.speedMultiplier = 20;

        // Stats element refs
        this._statsEl = null;
        this._chartCanvas = null;
        this._chartCtx = null;

        // Try to load saved state
        this.loadState();

        // Log param count once
        console.log('RL: Network params = ' + countParams(this.population[0].net));
    }

    // -------------------------------------------------------------------------
    // State extraction
    // -------------------------------------------------------------------------

    /**
     * Extract a 10-dimensional normalized state vector from the game.
     */
    RLAgent.prototype.extractState = function (runner) {
        var tRex = runner.tRex;
        var obstacles = runner.horizon.obstacles;
        var speed = runner.currentSpeed;

        // Filter obstacles ahead of the tRex.
        var ahead = [];
        for (var i = 0; i < obstacles.length; i++) {
            var o = obstacles[i];
            if (o.xPos + o.typeConfig.width * o.size > tRex.xPos) {
                ahead.push(o);
            }
        }

        var state = new Float64Array(12);

        if (ahead.length > 0) {
            var obs1 = ahead[0];
            var dist1 = obs1.xPos - tRex.xPos;
            // Time-to-impact in frames, normalized. Speed-independent so
            // the network learns one threshold that works at any speed.
            state[0] = Math.min(1, Math.max(0, (dist1 / speed) / 30));
            state[1] = obs1.typeConfig.type === 'PTERODACTYL' ? 1 : 0;
            state[2] = Math.min(1, Math.max(0, obs1.yPos / 150));
            state[3] = Math.min(1, Math.max(0, (obs1.typeConfig.width * obs1.size) / 150));
        } else {
            state[0] = 1.0;
            state[1] = 0;
            state[2] = 0.5;
            state[3] = 0;
        }

        if (ahead.length > 1) {
            var obs2 = ahead[1];
            var dist2 = obs2.xPos - tRex.xPos;
            state[4] = Math.min(1, Math.max(0, (dist2 / speed) / 30));
            state[5] = obs2.typeConfig.type === 'PTERODACTYL' ? 1 : 0;
            state[6] = Math.min(1, Math.max(0, obs2.yPos / 150));
        } else {
            state[4] = 1.0;
            state[5] = 0;
            state[6] = 0.5;
        }

        state[7] = Math.min(1, Math.max(0, (speed - 6) / 54));
        state[8] = Math.min(1, Math.max(0, (tRex.groundYPos - tRex.yPos) / 63));
        state[9] = tRex.jumping ? 1 : 0;
        state[10] = tRex.ducking ? 1 : 0;
        state[11] = ahead.length > 0 ?
            Math.min(1, Math.max(0, ahead[0].typeConfig.height / 100)) : 0;

        return state;
    };

    // -------------------------------------------------------------------------
    // Parallel evaluation — Ghost management
    // -------------------------------------------------------------------------

    /**
     * Create 50 GhostTrex instances, one per individual in the population.
     * Top NUM_ELITE are marked as elite survivors.
     */
    RLAgent.prototype._initGhosts = function () {
        if (!window.GhostTrex) return;
        this.ghosts = [];
        for (var i = 0; i < POPULATION_SIZE; i++) {
            var ghost = new window.GhostTrex(i, i < NUM_ELITE);
            this.ghosts.push(ghost);
        }
        this._ghostsInitialized = true;
        this._aliveCount = POPULATION_SIZE;
        this._globalFrame = 0;
    };

    /**
     * Extract state vector from a ghost (same features as extractState,
     * but using ghost position instead of runner.tRex).
     */
    RLAgent.prototype._extractGhostState = function (ghost, obstacles, speed) {
        var ahead = [];
        for (var i = 0; i < obstacles.length; i++) {
            var o = obstacles[i];
            if (o.xPos + o.typeConfig.width * o.size > ghost.xPos) {
                ahead.push(o);
            }
        }

        var state = new Float64Array(12);

        if (ahead.length > 0) {
            var obs1 = ahead[0];
            var dist1 = obs1.xPos - ghost.xPos;
            state[0] = Math.min(1, Math.max(0, (dist1 / speed) / 30));
            state[1] = obs1.typeConfig.type === 'PTERODACTYL' ? 1 : 0;
            state[2] = Math.min(1, Math.max(0, obs1.yPos / 150));
            state[3] = Math.min(1, Math.max(0, (obs1.typeConfig.width * obs1.size) / 150));
        } else {
            state[0] = 1.0;
            state[2] = 0.5;
        }

        if (ahead.length > 1) {
            var obs2 = ahead[1];
            var dist2 = obs2.xPos - ghost.xPos;
            state[4] = Math.min(1, Math.max(0, (dist2 / speed) / 30));
            state[5] = obs2.typeConfig.type === 'PTERODACTYL' ? 1 : 0;
            state[6] = Math.min(1, Math.max(0, obs2.yPos / 150));
        } else {
            state[4] = 1.0;
            state[6] = 0.5;
        }

        state[7] = Math.min(1, Math.max(0, (speed - 6) / 54));
        state[8] = Math.min(1, Math.max(0, (ghost.groundYPos - ghost.yPos) / 63));
        state[9] = ghost.jumping ? 1 : 0;
        state[10] = ghost.ducking ? 1 : 0;
        state[11] = ahead.length > 0 ?
            Math.min(1, Math.max(0, ahead[0].typeConfig.height / 100)) : 0;

        return state;
    };

    /**
     * Execute an action on a ghost (same as executeAction but for ghost).
     */
    RLAgent.prototype._executeGhostAction = function (action, ghost, speed) {
        switch (action) {
            case 0: // Run
                if (ghost.ducking) ghost.setDuck(false);
                break;
            case 1: // Jump
                if (!ghost.jumping) {
                    if (ghost.ducking) ghost.setDuck(false);
                    ghost.startJump(speed);
                }
                break;
            case 2: // Duck / speed-drop
                if (ghost.jumping) {
                    if (!ghost.speedDrop) ghost.setSpeedDrop();
                } else {
                    if (!ghost.ducking) ghost.setDuck(true);
                }
                break;
        }
    };

    // -------------------------------------------------------------------------
    // Action selection and execution
    // -------------------------------------------------------------------------

    /**
     * Pick action via argmax of current network's output.
     * @param {Float64Array} state State vector.
     * @return {number} Action index (0=run, 1=jump, 2=duck).
     */
    RLAgent.prototype.chooseAction = function (state) {
        var net = this.population[this.currentIndividual].net;
        var outputs = forward(state, net);
        // Argmax
        var bestIdx = 0;
        var bestVal = outputs[0];
        for (var i = 1; i < outputs.length; i++) {
            if (outputs[i] > bestVal) {
                bestVal = outputs[i];
                bestIdx = i;
            }
        }
        return bestIdx;
    };

    /**
     * Execute the chosen action and return the ACTUAL action taken.
     * If the requested action is impossible (e.g. jump while airborne),
     * we return what actually happened so the trajectory stays clean.
     */
    RLAgent.prototype.executeAction = function (action, runner) {
        var tRex = runner.tRex;
        var speed = runner.currentSpeed;

        switch (action) {
            case 0: // Run
                if (tRex.ducking) tRex.setDuck(false);
                return 0;
            case 1: // Jump
                if (!tRex.jumping) {
                    if (tRex.ducking) tRex.setDuck(false);
                    tRex.startJump(speed);
                    return 1;
                }
                return 0;
            case 2: // Duck / speed-drop
                if (tRex.jumping) {
                    if (!tRex.speedDrop) tRex.setSpeedDrop();
                    return 2;
                } else {
                    if (!tRex.ducking) tRex.setDuck(true);
                    return 2;
                }
        }
        return action;
    };

    // -------------------------------------------------------------------------
    // Main update — called every game frame
    // -------------------------------------------------------------------------

    RLAgent.prototype.update = function (runner) {
        if (!this.enabled || !runner.playing) return;

        // ---- Parallel mode ----
        if (this.parallelMode && window.GhostTrex) {
            // If the runner crashed (e.g. from a tab switch), restart it.
            if (runner.crashed) {
                if (runner.raqId) {
                    cancelAnimationFrame(runner.raqId);
                    runner.raqId = 0;
                    runner.updatePending = false;
                }
                runner.restart();
                runner.activated = true;
                return;
            }

            // Initialize ghosts if needed.
            if (!this._ghostsInitialized) {
                this._initGhosts();
            }

            var obstacles = runner.horizon.obstacles;
            var speed = runner.currentSpeed;

            this._globalFrame++;

            // Step each ghost: NN evaluation → action → physics.
            // Collision checking happens LATER in checkGhostCollisions(),
            // which is called from index.js AFTER obstacles have moved.
            for (var g = 0; g < this.ghosts.length; g++) {
                var ghost = this.ghosts[g];
                if (!ghost.alive) continue;

                // Evaluate NN for this ghost.
                var distToObs = 9999;
                for (var i = 0; i < obstacles.length; i++) {
                    var o = obstacles[i];
                    if (o.xPos + o.typeConfig.width * o.size > ghost.xPos) {
                        distToObs = o.xPos - ghost.xPos;
                        break;
                    }
                }
                var decisionZone = Math.max(DECISION_ZONE_BASE, speed * 10);
                var nearObstacle = distToObs < decisionZone;

                if (nearObstacle || ghost.jumping) {
                    var state = this._extractGhostState(ghost, obstacles, speed);
                    var net = this.population[g].net;
                    var outputs = forward(state, net);
                    var bestIdx = 0;
                    var bestVal = outputs[0];
                    for (var a = 1; a < outputs.length; a++) {
                        if (outputs[a] > bestVal) {
                            bestVal = outputs[a];
                            bestIdx = a;
                        }
                    }
                    this._executeGhostAction(bestIdx, ghost, speed);
                } else {
                    if (ghost.ducking) ghost.setDuck(false);
                }

                // Step physics.
                ghost.updatePhysics();
            }
            return;
        }

        // ---- Sequential mode (legacy / viewer replay) ----
        if (runner.crashed) return;

        var tRex = runner.tRex;
        var obstacles = runner.horizon.obstacles;
        var distToObs = 9999;
        for (var i = 0; i < obstacles.length; i++) {
            var o = obstacles[i];
            if (o.xPos + o.typeConfig.width * o.size > tRex.xPos) {
                distToObs = o.xPos - tRex.xPos;
                break;
            }
        }
        // Fix stuck ducking-during-jump state (see wrapper comment).
        if (tRex.jumping && tRex.ducking) {
            tRex.setDuck(false);
        }

        var decisionZone = Math.max(DECISION_ZONE_BASE, runner.currentSpeed * 10);
        var nearObstacle = distToObs < decisionZone;

        if (nearObstacle || tRex.jumping) {
            var state = this.extractState(runner);
            var action = this.chooseAction(state);
            this.executeAction(action, runner);
        } else {
            if (tRex.ducking) tRex.setDuck(false);
        }

        this.episodeScore = Math.round(runner.distanceRan * 0.025);
        this.totalSteps++;

        if (this.episodeScore >= this.maxScoreCap && !runner.crashed) {
            runner.gameOver();
            return;
        }

        if (this.totalSteps % 10 === 0) {
            this.updateStats();
        }
    };

    /**
     * Compatibility stub — the game's update loop calls this after update().
     * No-op for neuroevolution.
     */
    RLAgent.prototype.recordPrediction = function () {};

    // -------------------------------------------------------------------------
    // Ghost collision check — called from index.js AFTER obstacles have moved
    // -------------------------------------------------------------------------

    /**
     * Check ghost collisions against post-move obstacle positions.
     * This is separated from update() so it runs at the correct timing —
     * after horizon.update() moves obstacles, matching the real game's
     * collision check timing.
     */
    RLAgent.prototype.checkGhostCollisions = function (runner) {
        if (!this.enabled || !this.parallelMode || !this._ghostsInitialized) return;
        if (!this.ghosts || this.ghosts.length === 0) return;

        // Snapshot bestScore before collision deaths update it,
        // so evolve() can correctly detect stagnation.
        this._prevBestScore = this.bestScore;

        var obstacles = runner.horizon.obstacles;
        this._aliveCount = 0;
        var bestAliveIdx = -1;
        var bestAliveFitness = -1;

        for (var g = 0; g < this.ghosts.length; g++) {
            var ghost = this.ghosts[g];
            if (!ghost.alive) continue;

            // Check collision (using post-move obstacle positions).
            if (ghost.checkCollision(obstacles)) {
                ghost.alive = false;
                ghost.deathFrame = this._globalFrame;
                ghost.fitness = Math.round(runner.distanceRan * 0.025);
                this.population[g].fitness = ghost.fitness;
                if (ghost.fitness > this.bestScore) {
                    this.bestScore = ghost.fitness;
                }
                continue;
            }

            // Track alive ghosts.
            this._aliveCount++;
            ghost.fitness = Math.round(runner.distanceRan * 0.025);
            if (ghost.fitness > bestAliveFitness) {
                bestAliveFitness = ghost.fitness;
                bestAliveIdx = g;
            }
        }

        // Sync real tRex to best alive ghost (camera follows it).
        if (bestAliveIdx >= 0) {
            var best = this.ghosts[bestAliveIdx];
            runner.tRex.yPos = best.yPos;
            runner.tRex.jumping = best.jumping;
            runner.tRex.ducking = best.ducking;
        }

        this.episodeScore = Math.round(runner.distanceRan * 0.025);
        this.totalSteps++;

        // Score cap: end generation early if best alive reaches cap.
        if (this.episodeScore >= this.maxScoreCap) {
            for (var g = 0; g < this.ghosts.length; g++) {
                if (this.ghosts[g].alive) {
                    this.ghosts[g].alive = false;
                    this.population[g].fitness = this.maxScoreCap;
                }
            }
            this._aliveCount = 0;
            // Update bestScore for cap-killed ghosts too.
            if (this.maxScoreCap > this.bestScore) {
                this.bestScore = this.maxScoreCap;
            }
        }

        // All dead → evolve (or start second eval pass for dual-speed).
        if (this._aliveCount === 0) {
            // Dual-speed evaluation: test each network at both speed 6
            // and MAX_SPEED, then use min(fitness) for selection.
            // This ensures only networks good at BOTH speeds survive.
            if (this._dualSpeedEval && !this._dualPass2) {
                // First pass just finished (speed 6). Save fitnesses.
                this._pass1Fitness = [];
                for (var g = 0; g < this.population.length; g++) {
                    this._pass1Fitness[g] = this.population[g].fitness;
                    this.population[g].fitness = 0;
                }
                // Rerun same population with natural acceleration up to MAX_SPEED.
                // Restore MAX_SPEED for second pass, start from normal speed.
                // Natural acceleration + progressive caps create a curriculum:
                //   cap 5000 → game reaches ~speed 21 before cap
                //   cap 20000 → ~speed 35
                //   cap 50000 → ~speed 50
                this._dualPass2 = true;
                this._initGhosts();
                runner.distanceRan = 0;
                if (this._savedMaxSpeed !== undefined) {
                    runner.config.MAX_SPEED = this._savedMaxSpeed;
                }
                runner.setSpeed(runner.config.SPEED);
                runner.currentSpeed = runner.config.SPEED;
                runner.time = performance.now();
                runner.horizon.obstacles = [];
                runner.tRex.reset();
                runner.tRex.update(0, Trex.status.RUNNING);
                runner.invert(true);
                // Skip evolve — continue to next frame.
            } else {
                if (this._dualSpeedEval && this._dualPass2) {
                    // Second pass done. Combine: fitness = min(pass1, pass2).
                    for (var g = 0; g < this.population.length; g++) {
                        var f1 = this._pass1Fitness[g] || 0;
                        var f2 = this.population[g].fitness;
                        this.population[g].fitness = Math.min(f1, f2);
                    }
                    this._dualPass2 = false;
                    this._pass1Fitness = null;
                }

                this.evolve();
                this._initGhosts();
                this.updateStats();
                this.drawChart();
                this.saveState();
                // Seamless generation transition: reset distance and obstacles
                // for correct training, but avoid full visual "rewind" snap.
                // Keep ground line, tRex, and speed so the scene doesn't jerk.
                runner.distanceRan = 0;
                // For dual-speed eval, first pass uses natural acceleration
                // up to default MAX_SPEED (13). This ensures pterodactyls
                // spawn (they require speed >= 8.5), so networks learn ducking.
                // Pass 2 then tests up to the user's MAX_SPEED (e.g. 50).
                if (this._dualSpeedEval) {
                    this._savedMaxSpeed = runner.config.MAX_SPEED;
                    runner.config.MAX_SPEED = 13;
                    runner.setSpeed(runner.config.SPEED);
                    runner.currentSpeed = runner.config.SPEED;
                } else if (this._randomizeSpeed) {
                    var rndSpeed = Math.random() < 0.5 ? 6 : runner.config.MAX_SPEED;
                    runner.setSpeed(rndSpeed);
                    runner.currentSpeed = rndSpeed;
                } else {
                    // Start each gen at MAX_SPEED instantly. This trains the
                    // network for the hardest speed directly. Progressive caps
                    // control how LONG it must survive, not how fast it goes.
                    runner.setSpeed(runner.config.MAX_SPEED);
                    runner.currentSpeed = runner.config.MAX_SPEED;
                }
                runner.time = performance.now();
                // Clear obstacles so new ghosts don't spawn on top of old ones.
                runner.horizon.obstacles = [];
                // Reset tRex to ground for clean visual transition.
                runner.tRex.reset();
                runner.tRex.update(0, Trex.status.RUNNING);
                runner.invert(true);

                // In decoupled mode, training just keeps going silently.
                // The visual replay on the visible runner handles itself
                // independently via _checkReplayCollisions.
            }
            return;
        }

        // Update stats every 10 frames.
        if (this.totalSteps % 10 === 0) {
            this.updateStats();
        }
    };

    // -------------------------------------------------------------------------
    // On crash — end of episode for current individual
    // -------------------------------------------------------------------------

    RLAgent.prototype.onCrash = function (runner) {
        // In parallel mode, collisions are handled in update() — not here.
        if (this.parallelMode) return;

        var score = Math.round(runner.distanceRan * 0.025);
        this.population[this.currentIndividual].fitness = score;

        if (score > this.bestScore) this.bestScore = score;

        this.currentIndividual++;

        // Check if all individuals in this generation have been evaluated.
        if (this.currentIndividual >= POPULATION_SIZE) {
            this.evolve();
        }

        // Reset per-episode state.
        this.episodeScore = 0;

        // Update UI.
        this.updateStats();
        this.drawChart();

        // Save periodically (every generation).
        if (this.currentIndividual === 0) {
            this.saveState();
        }
    };

    // -------------------------------------------------------------------------
    // Evolution
    // -------------------------------------------------------------------------

    RLAgent.prototype.evolve = function () {
        // Sort population by fitness (descending).
        this.population.sort(function (a, b) { return b.fitness - a.fitness; });

        // Record best fitness of this generation.
        var genBest = this.population[0].fitness;
        this.generationBestHistory.push(genBest);

        // Save snapshot of best network for replay.
        this.generationSnapshots.push({
            gen: this.generation,
            fitness: genBest,
            net: serializeNetwork(this.population[0].net)
        });
        this._thinSnapshots();
        this.populateSnapshotDropdowns();

        console.log('RL: Gen ' + this.generation +
            ' | Best: ' + genBest +
            ' | Avg: ' + this._genAvg().toFixed(1) +
            ' | sigma: ' + this.sigma.toFixed(4));

        // Select parents (top NUM_PARENTS).
        var parents = [];
        for (var i = 0; i < NUM_PARENTS; i++) {
            parents.push(this.population[i]);
        }

        // Build next generation.
        var nextPop = [];

        // Elitism: keep top NUM_ELITE unchanged.
        for (var i = 0; i < NUM_ELITE; i++) {
            nextPop.push({
                net: cloneNetwork(parents[i].net),
                fitness: 0
            });
        }

        // Fill rest with mutated offspring.
        while (nextPop.length < POPULATION_SIZE) {
            // Pick a random parent (uniform from the top NUM_PARENTS).
            var p1Idx = Math.floor(Math.random() * NUM_PARENTS);
            var child;

            // 30% chance of crossover between two parents.
            if (Math.random() < 0.3 && NUM_PARENTS > 1) {
                var p2Idx = p1Idx;
                while (p2Idx === p1Idx) {
                    p2Idx = Math.floor(Math.random() * NUM_PARENTS);
                }
                child = crossoverNetworks(parents[p1Idx].net, parents[p2Idx].net);
            } else {
                child = cloneNetwork(parents[p1Idx].net);
            }

            mutateNetwork(child, this.sigma);
            nextPop.push({ net: child, fitness: 0 });
        }

        this.population = nextPop;
        this.currentIndividual = 0;
        this.generation++;

        // Track stagnation and adapt sigma.
        // Compare against _prevBestScore (snapshot from before collision deaths
        // updated bestScore), so we correctly detect new highs.
        if (genBest > this._prevBestScore) {
            this._gensSinceImprove = 0;
        } else {
            this._gensSinceImprove++;
        }

        if (this._gensSinceImprove >= this.stagnationGens) {
            // Stuck — boost sigma to explore new strategies.
            this.sigma = Math.min(this.sigmaStart, this.sigma * 3);
            this._gensSinceImprove = 0;
            console.log('RL: Stagnation detected — sigma reset to ' + this.sigma.toFixed(3));
        } else {
            // Normal decay.
            this.sigma = Math.max(this.sigmaMin, this.sigma * this.sigmaDecay);
        }

        // Progressive score cap: raise cap when population consistently near-maxes it.
        // Use 90% threshold instead of exact cap to handle random obstacle variance.
        if (genBest >= this.maxScoreCap * 0.9) {
            this._capHitCount = (this._capHitCount || 0) + 1;
            if (this._capHitCount >= 5 && this.maxScoreCap < 50000) {
                var oldCap = this.maxScoreCap;
                this.maxScoreCap = Math.min(50000, this.maxScoreCap * 2);
                this._capHitCount = 0;
                console.log('RL: Progressive cap raised ' + oldCap + ' → ' + this.maxScoreCap);
                // Update slider if present.
                var sl = document.getElementById('slider-scorecap');
                var sv = document.getElementById('val-scorecap');
                if (sl) sl.value = this.maxScoreCap;
                if (sv) sv.textContent = String(this.maxScoreCap);
            }
        } else {
            this._capHitCount = 0;
        }
    };

    /** Compute average fitness of current (completed) generation. */
    RLAgent.prototype._genAvg = function () {
        var sum = 0;
        for (var i = 0; i < this.population.length; i++) {
            sum += this.population[i].fitness;
        }
        return sum / this.population.length;
    };

    // -------------------------------------------------------------------------
    // Stats and Chart
    // -------------------------------------------------------------------------

    RLAgent.prototype.updateStats = function () {
        var el = this._statsEl || document.getElementById('rl-stats');
        if (!el) return;
        this._statsEl = el;

        if (this._trainPhase === 'demo') {
            var runner = this._runner;
            var demoScore = runner ? Math.round(runner.distanceRan * 0.025) : 0;
            el.innerHTML =
                'Gen: <b>' + this.generation + '</b>' +
                ' &nbsp;|&nbsp; Best: <b>' + this.bestScore + '</b>' +
                ' &nbsp;|&nbsp; &sigma;: <b>' + this.sigma.toFixed(3) + '</b>' +
                ' &nbsp;|&nbsp; <span style="color:#4a9eff">Demo: ' + demoScore + '</span>';
            return;
        }

        if (this.parallelMode && this._ghostsInitialized) {
            var replayInfo = '';
            if (this._replayGhosts && this._replayAlive !== undefined) {
                replayInfo = ' &nbsp;|&nbsp; <span style="color:#4a9eff">Replay: ' +
                    this._replayAlive + '/' + POPULATION_SIZE + ' alive</span>';
            }
            el.innerHTML =
                'Gen: <b>' + this.generation + '</b>' +
                ' &nbsp;|&nbsp; Best: <b>' + this.bestScore + '</b>' +
                ' &nbsp;|&nbsp; &sigma;: <b>' + this.sigma.toFixed(3) + '</b>' +
                replayInfo;
        } else {
            // Sequential mode stats.
            var avgThisGen = 0;
            var evaluated = this.currentIndividual;
            if (evaluated > 0) {
                var sum = 0;
                for (var i = 0; i < evaluated; i++) {
                    sum += this.population[i].fitness;
                }
                avgThisGen = Math.round(sum / evaluated);
            }
            el.innerHTML =
                'Gen: <b>' + this.generation + '</b>' +
                ' &nbsp;|&nbsp; Individual: <b>' + (this.currentIndividual + 1) + '/' + POPULATION_SIZE + '</b>' +
                ' &nbsp;|&nbsp; Score: <b>' + this.episodeScore + '</b>' +
                ' &nbsp;|&nbsp; Best: <b>' + this.bestScore + '</b>' +
                ' &nbsp;|&nbsp; &sigma;: <b>' + this.sigma.toFixed(3) + '</b>' +
                ' &nbsp;|&nbsp; Avg: <b>' + avgThisGen + '</b>';
        }
    };

    RLAgent.prototype.drawChart = function () {
        var canvas = this._chartCanvas || document.getElementById('learning-curve');
        if (!canvas) return;
        this._chartCanvas = canvas;
        var ctx = canvas.getContext('2d');
        this._chartCtx = ctx;

        var W = canvas.width;
        var H = canvas.height;
        var pad = { top: 20, right: 20, bottom: 30, left: 50 };
        var plotW = W - pad.left - pad.right;
        var plotH = H - pad.top - pad.bottom;

        // Clear canvas.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);

        var scores = this.generationBestHistory;
        if (scores.length < 1) return;

        // Compute max score for Y axis.
        var maxScore = 0;
        for (var i = 0; i < scores.length; i++) {
            if (scores[i] > maxScore) maxScore = scores[i];
        }
        maxScore = Math.max(50, maxScore * 1.1);

        // Draw axes.
        ctx.strokeStyle = '#d2d2d7';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, pad.top);
        ctx.lineTo(pad.left, pad.top + plotH);
        ctx.lineTo(pad.left + plotW, pad.top + plotH);
        ctx.stroke();

        // Y-axis labels — use nice round intervals.
        var niceStep;
        if (maxScore <= 100) niceStep = 25;
        else if (maxScore <= 500) niceStep = 100;
        else if (maxScore <= 2000) niceStep = 500;
        else niceStep = 1000 * Math.max(1, Math.floor(maxScore / 5000));
        ctx.fillStyle = '#6e6e73';
        ctx.font = '11px -apple-system, sans-serif';
        ctx.textAlign = 'right';
        for (var val = 0; val <= maxScore; val += niceStep) {
            var y = pad.top + plotH - (val / maxScore) * plotH;
            ctx.fillText(String(val), pad.left - 5, y + 4);
            if (val > 0) {
                ctx.strokeStyle = '#e8e8ed';
                ctx.beginPath();
                ctx.moveTo(pad.left, y);
                ctx.lineTo(pad.left + plotW, y);
                ctx.stroke();
            }
        }

        // X-axis tick marks at nice round intervals.
        var nGens = scores.length;
        var xStep;
        if (nGens <= 10) xStep = 1;
        else if (nGens <= 50) xStep = 5;
        else if (nGens <= 100) xStep = 10;
        else if (nGens <= 500) xStep = 50;
        else xStep = 100 * Math.max(1, Math.floor(nGens / 500));
        ctx.fillStyle = '#6e6e73';
        ctx.font = '11px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        var xScaleAxis = nGens > 1 ? plotW / (nGens - 1) : plotW;
        for (var g = 0; g < nGens; g += xStep) {
            if (g === 0 && nGens > 10) continue;  // skip 0 to avoid label overlap
            var x = pad.left + g * xScaleAxis;
            ctx.fillText(String(g), x, pad.top + plotH + 15);
            ctx.strokeStyle = '#e8e8ed';
            ctx.beginPath();
            ctx.moveTo(x, pad.top);
            ctx.lineTo(x, pad.top + plotH);
            ctx.stroke();
        }

        // Plot best fitness per generation (blue dots).
        var xScale = scores.length > 1 ? plotW / (scores.length - 1) : plotW;
        ctx.fillStyle = 'rgba(0, 113, 227, 0.5)';
        for (var i = 0; i < scores.length; i++) {
            var x = pad.left + (scores.length > 1 ? i * xScale : plotW / 2);
            var y = pad.top + plotH - (scores[i] / maxScore) * plotH;
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
        }

        // Plot 10-generation moving average (orange line).
        if (scores.length >= 2) {
            ctx.strokeStyle = '#ff9f0a';
            ctx.lineWidth = 2;
            ctx.beginPath();
            var avgWindow = 10;
            var started = false;
            for (var i = 0; i < scores.length; i++) {
                var start = Math.max(0, i - avgWindow + 1);
                var sum = 0;
                for (var j = start; j <= i; j++) sum += scores[j];
                var avg = sum / (i - start + 1);
                var x = pad.left + i * xScale;
                var y = pad.top + plotH - (avg / maxScore) * plotH;
                if (!started) { ctx.moveTo(x, y); started = true; }
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }

        // Legend.
        ctx.fillStyle = 'rgba(0, 113, 227, 0.5)';
        ctx.fillRect(pad.left + 10, pad.top + 5, 10, 10);
        ctx.fillStyle = '#6e6e73';
        ctx.textAlign = 'left';
        ctx.font = '10px -apple-system, sans-serif';
        ctx.fillText('Best Fitness', pad.left + 25, pad.top + 14);

        ctx.strokeStyle = '#ff9f0a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pad.left + 10, pad.top + 25);
        ctx.lineTo(pad.left + 20, pad.top + 25);
        ctx.stroke();
        ctx.fillStyle = '#6e6e73';
        ctx.fillText('Avg (10 gen)', pad.left + 25, pad.top + 28);
    };

    // -------------------------------------------------------------------------
    // Persistence — localStorage
    // -------------------------------------------------------------------------

    RLAgent.prototype.saveState = function () {
        try {
            // Serialize the full population.
            var popData = [];
            for (var i = 0; i < this.population.length; i++) {
                popData.push({
                    net: serializeNetwork(this.population[i].net),
                    fitness: this.population[i].fitness
                });
            }

            var data = {
                version: RL_NET_VERSION,
                generation: this.generation,
                sigma: this.sigma,
                bestScore: this.bestScore,
                totalSteps: this.totalSteps,
                currentIndividual: this.currentIndividual,
                generationBestHistory: this.generationBestHistory.slice(-500),
                population: popData
            };
            localStorage.setItem('dinoRL', JSON.stringify(data));
            this.saveSnapshots();
        } catch (e) {
            console.warn('RL: Failed to save state:', e);
        }
    };

    RLAgent.prototype.loadState = function () {
        try {
            var json = localStorage.getItem('dinoRL');
            if (!json) return;
            var data = JSON.parse(json);

            // Version check: if saved network architecture doesn't match
            // current version, discard incompatible data and start fresh.
            if ((data.version || 1) !== RL_NET_VERSION) {
                console.log('RL: Saved data is version ' + (data.version || 1) +
                    ', current is ' + RL_NET_VERSION + ' — clearing incompatible data');
                this.resetState();
                return;
            }

            this.generation = data.generation || 0;
            this.sigma = data.sigma || this.sigmaStart;
            this.bestScore = data.bestScore || 0;
            this.totalSteps = data.totalSteps || 0;
            this.currentIndividual = data.currentIndividual || 0;
            this.generationBestHistory = data.generationBestHistory || [];

            if (data.population && data.population.length === POPULATION_SIZE) {
                for (var i = 0; i < POPULATION_SIZE; i++) {
                    if (data.population[i].net) {
                        deserializeNetwork(data.population[i].net, this.population[i].net);
                    }
                    this.population[i].fitness = data.population[i].fitness || 0;
                }
            }

            this.loadSnapshots();
            console.log('RL: Loaded saved state — gen ' + this.generation +
                ', sigma ' + this.sigma.toFixed(3) + ', best ' + this.bestScore +
                ', snapshots ' + this.generationSnapshots.length);
        } catch (e) {
            console.warn('RL: Failed to load state:', e);
        }
    };

    RLAgent.prototype.resetState = function () {
        localStorage.removeItem('dinoRL');
        localStorage.removeItem('dinoRL_snapshots');

        this.generation = 0;
        this.sigma = this.sigmaStart;
        this.bestScore = 0;
        this._prevBestScore = 0;
        this._gensSinceImprove = 0;
        this.totalSteps = 0;
        this.currentIndividual = 0;
        this.generationBestHistory = [];
        this.generationSnapshots = [];
        this.episodeScore = 0;
        this.ghosts = [];
        this._ghostsInitialized = false;
        this._globalFrame = 0;
        this._aliveCount = 0;

        // Reinitialize population with fresh random networks.
        this.population = [];
        for (var i = 0; i < POPULATION_SIZE; i++) {
            this.population.push({
                net: createNetwork(LAYER_SIZES),
                fitness: 0
            });
        }

        this.updateStats();
        this.drawChart();
        this.populateSnapshotDropdowns();
        console.log('RL: Agent reset to fresh state.');
    };

    /** Thin old snapshots to prevent localStorage bloat. */
    RLAgent.prototype._thinSnapshots = function () {
        if (this.generationSnapshots.length <= 50) return;
        var snaps = this.generationSnapshots;
        var keep = [];
        for (var i = 0; i < snaps.length; i++) {
            var gen = snaps[i].gen;
            var age = this.generation - gen;
            // Keep all from last 20 generations
            if (age <= 20) { keep.push(snaps[i]); continue; }
            // Keep every 5th for gens 20-100 ago
            if (age <= 100 && gen % 5 === 0) { keep.push(snaps[i]); continue; }
            // Keep every 10th for older
            if (age > 100 && gen % 10 === 0) { keep.push(snaps[i]); continue; }
        }
        this.generationSnapshots = keep;
    };

    RLAgent.prototype.saveSnapshots = function () {
        try {
            localStorage.setItem('dinoRL_snapshots', JSON.stringify(this.generationSnapshots));
        } catch (e) {
            console.warn('RL: Failed to save snapshots:', e);
        }
    };

    RLAgent.prototype.loadSnapshots = function () {
        try {
            var json = localStorage.getItem('dinoRL_snapshots');
            if (json) this.generationSnapshots = JSON.parse(json);
        } catch (e) {
            console.warn('RL: Failed to load snapshots:', e);
        }
    };

    function serializeNetwork(net) {
        var layers = [];
        for (var i = 0; i < net.layers.length; i++) {
            layers.push({
                W: Array.from(net.layers[i].W),
                b: Array.from(net.layers[i].b),
                rows: net.layers[i].rows,
                cols: net.layers[i].cols
            });
        }
        return { layers: layers, sizes: net.sizes };
    }

    function deserializeNetwork(data, net) {
        for (var i = 0; i < data.layers.length; i++) {
            net.layers[i].W = new Float64Array(data.layers[i].W);
            net.layers[i].b = new Float64Array(data.layers[i].b);
        }
    }

    // -------------------------------------------------------------------------
    // Speed control
    // -------------------------------------------------------------------------

    RLAgent.prototype.setSpeedMultiplier = function (mult) {
        this.speedMultiplier = mult;
        var runner = this._runner;   // visible evoRunner
        if (!runner) return;

        // Stop any existing training loop.
        this._stopTrainingLoop();

        if (!this.enabled) return;

        // -- Decoupled mode --
        // Training runs FAST on a hidden runner via MessageChannel pump.
        // The visible runner shows a replay of the latest generation's
        // networks at normal speed with coloured ghost overlays.
        this._trainingRunning = true;
        this._trainPhase = 'silent';
        this._skipRender = true;

        // Save original acceleration for restoration when training stops.
        this._savedAcceleration = runner.config.ACCELERATION;

        // ---- Create hidden training runner ----
        this._createTrainingRunner(runner);

        // ---- Start fast training on hidden runner ----
        this._startSilentPhase();

        // ---- Start visual replay on visible runner ----
        this._startReplay(runner);
    };

    // -------------------------------------------------------------------------
    // Hidden training runner — fast physics-only game for background training
    // -------------------------------------------------------------------------

    /**
     * Create a hidden Runner for training. It has its own canvas, obstacles,
     * and physics — completely independent of the visible runner.
     */
    RLAgent.prototype._createTrainingRunner = function (visibleRunner) {
        // Reuse existing training runner if still alive.
        if (this._trainingRunner) return;

        // Create hidden container if needed.
        var container = document.getElementById('evo-train-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'evo-train-container';
            container.style.cssText = 'position:absolute;left:-9999px;width:600px;height:150px;overflow:hidden;';
            document.body.appendChild(container);
        }
        // Add interstitial-wrapper inside (Runner expects this structure).
        container.innerHTML = '<div class="interstitial-wrapper" style="width:600px;height:150px;"></div>';
        var wrapper = container.querySelector('.interstitial-wrapper');

        // Create hidden runner.
        var savedInstance = Runner.instance_;
        this._trainingRunner = new Runner(wrapper, {}, { primary: false });
        // Restore Runner.instance_ so keyboard events go to the primary runner.
        Runner.instance_ = savedInstance;

        // Set up training runner config to match visible runner.
        var tr = this._trainingRunner;
        tr.containerEl.style.width = tr.dimensions.WIDTH + 'px';
        tr.setArcadeMode();
        tr.suppressCollision = true;

        // Copy speed settings from visible runner.
        tr.config.MAX_SPEED = visibleRunner.config.MAX_SPEED;
        tr.config.ACCELERATION = visibleRunner.config.ACCELERATION;
        tr.config.SPEED = visibleRunner.config.SPEED;

        // Attach this agent as aiAgent for training updates.
        tr.aiAgent = this;
        tr.postRenderHook = null; // No visual rendering needed.

        // Start the training runner's game.
        tr.playing = true;
        tr.crashed = false;
        tr.activated = true;
        tr.playingIntro = false;
        tr.tRex.playingIntro = false;
        tr.distanceRan = 0;

        // Set speed for first generation.
        if (this._dualSpeedEval) {
            this._savedMaxSpeed = visibleRunner.config.MAX_SPEED;
            tr.config.MAX_SPEED = 13;
            tr.setSpeed(tr.config.SPEED);
            tr.currentSpeed = tr.config.SPEED;
        } else {
            tr.setSpeed(tr.config.MAX_SPEED);
            tr.currentSpeed = tr.config.MAX_SPEED;
        }
        tr.time = performance.now();
        tr.horizon.reset();
        tr.horizon.obstacles = [];
        tr.tRex.reset();
        tr.tRex.update(0, Trex.status.RUNNING);
        tr.invert(true);

        // Neuter the training runner's scheduleNextUpdate so rAF doesn't
        // drive it — we drive it manually via MessageChannel pump.
        this._origTrainingSchedule = tr.scheduleNextUpdate.bind(tr);
        tr.scheduleNextUpdate = function () {};
    };

    /**
     * Destroy the hidden training runner and clean up.
     */
    RLAgent.prototype._destroyTrainingRunner = function () {
        if (this._trainingRunner) {
            if (this._trainingRunner.raqId) {
                cancelAnimationFrame(this._trainingRunner.raqId);
            }
            this._trainingRunner.aiAgent = null;
            this._trainingRunner = null;
        }
        var container = document.getElementById('evo-train-container');
        if (container) container.innerHTML = '';
    };

    // -------------------------------------------------------------------------
    // Visual replay — shows latest generation's ghosts on visible runner
    // -------------------------------------------------------------------------

    /**
     * Start a visual replay on the visible runner. Creates replay ghosts
     * loaded with the current population's networks.
     */
    RLAgent.prototype._startReplay = function (runner) {
        var self = this;

        // Snapshot current population networks for replay.
        this._snapshotForReplay();

        // Create replay ghost instances.
        this._replayGhosts = [];
        for (var i = 0; i < POPULATION_SIZE; i++) {
            var ghost = new window.GhostTrex(i, i < NUM_ELITE);
            this._replayGhosts.push(ghost);
        }
        this._replayAlive = POPULATION_SIZE;
        this._replayFrame = 0;

        // Set up replay agent on visible runner.
        var replayAgent = {
            enabled: true,
            update: function (r) {
                if (!self._trainingRunning) return;
                if (!r.playing) return;
                self._updateReplayGhosts(r);
            },
            onCrash: function () {
                // Visible runner crashed — restart replay.
                self._restartReplay(runner);
            },
            recordPrediction: function () {},
            checkGhostCollisions: function (r) {
                if (!self._trainingRunning) return;
                self._checkReplayCollisions(r);
            }
        };
        this._replayAgent = replayAgent;

        // Configure visible runner for replay (normal speed, rendering on).
        runner.aiAgent = replayAgent;
        runner.postRenderHook = function (ctx, r) {
            self._drawReplayGhosts(ctx, r);
        };
        runner.suppressCollision = true;

        // Start visible runner at normal speed.
        runner.playing = true;
        runner.crashed = false;
        runner.activated = true;
        runner.distanceRan = 0;
        runner.setSpeed(runner.config.SPEED);
        runner.currentSpeed = runner.config.SPEED;
        runner.time = performance.now();
        runner.horizon.reset();
        runner.horizon.obstacles = [];
        runner.tRex.reset();
        runner.tRex.update(0, Trex.status.RUNNING);
        runner.invert(true);

        // Kick off rAF loop for the visible runner.
        if (runner.raqId) {
            cancelAnimationFrame(runner.raqId);
            runner.raqId = 0;
        }
        runner.update();

        // Periodic stats + chart update (training runs fast in background,
        // so we poll periodically to keep the UI current).
        if (this._replayStatsInterval) clearInterval(this._replayStatsInterval);
        this._replayStatsInterval = setInterval(function () {
            if (!self._trainingRunning) {
                clearInterval(self._replayStatsInterval);
                self._replayStatsInterval = null;
                return;
            }
            self.updateStats();
            self.drawChart();
        }, 300);
    };

    /**
     * Snapshot the current population's networks for replay use.
     */
    RLAgent.prototype._snapshotForReplay = function () {
        this._replayNets = [];
        for (var i = 0; i < this.population.length; i++) {
            this._replayNets.push(cloneNetwork(this.population[i].net));
        }
        this._replayGen = this.generation;
    };

    /**
     * Update replay ghosts each frame (AI decisions + physics).
     */
    RLAgent.prototype._updateReplayGhosts = function (runner) {
        if (!this._replayGhosts || this._replayGhosts.length === 0) return;

        var obstacles = runner.horizon.obstacles;
        var speed = runner.currentSpeed;
        this._replayFrame++;

        for (var g = 0; g < this._replayGhosts.length; g++) {
            var ghost = this._replayGhosts[g];
            if (!ghost.alive) continue;

            // NN evaluation.
            var distToObs = 9999;
            for (var i = 0; i < obstacles.length; i++) {
                var o = obstacles[i];
                if (o.xPos + o.typeConfig.width * o.size > ghost.xPos) {
                    distToObs = o.xPos - ghost.xPos;
                    break;
                }
            }
            var decisionZone = Math.max(DECISION_ZONE_BASE, speed * 10);

            if (distToObs < decisionZone || ghost.jumping) {
                var state = this._extractGhostState(ghost, obstacles, speed);
                var net = this._replayNets[g];
                if (!net) continue;
                var outputs = forward(state, net);
                var bestIdx = 0;
                var bestVal = outputs[0];
                for (var a = 1; a < outputs.length; a++) {
                    if (outputs[a] > bestVal) {
                        bestVal = outputs[a];
                        bestIdx = a;
                    }
                }
                this._executeGhostAction(bestIdx, ghost, speed);
            } else {
                if (ghost.ducking) ghost.setDuck(false);
            }

            ghost.updatePhysics();
        }
    };

    /**
     * Check replay ghost collisions. When all die, restart with latest nets.
     */
    RLAgent.prototype._checkReplayCollisions = function (runner) {
        if (!this._replayGhosts || this._replayGhosts.length === 0) return;

        var obstacles = runner.horizon.obstacles;
        this._replayAlive = 0;
        var bestAliveIdx = -1;
        var bestAliveFitness = -1;

        for (var g = 0; g < this._replayGhosts.length; g++) {
            var ghost = this._replayGhosts[g];
            if (!ghost.alive) continue;

            if (ghost.checkCollision(obstacles)) {
                ghost.alive = false;
                ghost.deathFrame = this._replayFrame;
                ghost.fitness = Math.round(runner.distanceRan * 0.025);
                continue;
            }

            this._replayAlive++;
            ghost.fitness = Math.round(runner.distanceRan * 0.025);
            if (ghost.fitness > bestAliveFitness) {
                bestAliveFitness = ghost.fitness;
                bestAliveIdx = g;
            }
        }

        // Sync visible tRex to best alive replay ghost.
        if (bestAliveIdx >= 0) {
            var best = this._replayGhosts[bestAliveIdx];
            runner.tRex.yPos = best.yPos;
            runner.tRex.jumping = best.jumping;
            runner.tRex.ducking = best.ducking;
        }

        // All replay ghosts dead → restart with latest snapshot.
        if (this._replayAlive === 0) {
            this._restartReplay(runner);
        }
    };

    /**
     * Restart the visual replay with the latest training snapshot.
     */
    RLAgent.prototype._restartReplay = function (runner) {
        if (!this._trainingRunning) return;

        // Grab the latest networks from training.
        this._snapshotForReplay();

        // Reset replay ghosts.
        this._replayGhosts = [];
        for (var i = 0; i < POPULATION_SIZE; i++) {
            this._replayGhosts.push(new window.GhostTrex(i, i < NUM_ELITE));
        }
        this._replayAlive = POPULATION_SIZE;
        this._replayFrame = 0;

        // Reset visible runner for new replay.
        runner.distanceRan = 0;
        runner.setSpeed(runner.config.SPEED);
        runner.currentSpeed = runner.config.SPEED;
        runner.time = performance.now();
        runner.horizon.obstacles = [];
        runner.tRex.reset();
        runner.tRex.update(0, Trex.status.RUNNING);
        runner.invert(true);
    };

    /**
     * Draw replay ghosts on the visible canvas.
     */
    RLAgent.prototype._drawReplayGhosts = function (ctx, runner) {
        if (!this._replayGhosts || this._replayGhosts.length === 0) return;

        // Find best alive for highlight.
        var bestAliveIdx = -1;
        var bestAliveFitness = -1;
        for (var i = 0; i < this._replayGhosts.length; i++) {
            if (this._replayGhosts[i].alive &&
                this._replayGhosts[i].fitness > bestAliveFitness) {
                bestAliveFitness = this._replayGhosts[i].fitness;
                bestAliveIdx = this._replayGhosts[i].index;
            }
        }

        // Draw dead first (behind), then alive.
        for (var pass = 0; pass < 2; pass++) {
            for (var i = 0; i < this._replayGhosts.length; i++) {
                var ghost = this._replayGhosts[i];
                var isDead = !ghost.alive;
                if ((pass === 0 && !isDead) || (pass === 1 && isDead)) continue;
                ghost.draw(ctx, this._replayFrame, bestAliveIdx);
            }
        }
    };

    /**
     * Demo phase: play the current best network solo at 1x so the user can
     * watch progress. This is purely visual — it doesn't affect training.
     * Ends automatically after hitting demoScoreCap or after a crash,
     * then transitions back to silent training.
     */
    RLAgent.prototype._startDemoPhase = function () {
        this._trainPhase = 'demo';
        this._skipRender = false;
        // Close any silent-phase channel.
        if (this._trainingChannel) {
            this._trainingChannel.port1.close();
            this._trainingChannel.port2.close();
            this._trainingChannel = null;
        }

        var self = this;
        var runner = this._runner;
        var frameDt = 1000 / 60;

        // Build a network from the current best.
        var bestSerialized = this.getBestNetwork();
        var demoNet = createNetwork(LAYER_SIZES);
        deserializeNetwork(bestSerialized, demoNet);

        // Save real aiAgent so we can restore after demo.
        var realAgent = runner.aiAgent;

        // Swap in a lightweight demo agent that plays demoNet solo.
        // IMPORTANT: onCrash and score-cap end are called from inside
        // runner.update(). We must NOT call _endDemo synchronously there
        // (re-entrance). Instead, set a flag and let tick() handle it.
        var demoEnding = false;
        var demoAgent = {
            enabled: true,
            update: function (r) {
                if (!r.playing || demoEnding) return;
                var score = Math.round(r.distanceRan * 0.025);

                // End demo if we hit the demo score cap.
                if (score >= (self._demoScoreCap || 3000)) {
                    demoEnding = true;
                    return;
                }

                var tRex = r.tRex;
                if (tRex.jumping && tRex.ducking) tRex.setDuck(false);
                var obstacles = r.horizon.obstacles;
                var speed = r.currentSpeed;
                var distToObs = 9999;
                for (var i = 0; i < obstacles.length; i++) {
                    var o = obstacles[i];
                    if (o.xPos + o.typeConfig.width * o.size > tRex.xPos) {
                        distToObs = o.xPos - tRex.xPos;
                        break;
                    }
                }
                var decisionZone = Math.max(DECISION_ZONE_BASE, speed * 10);
                if (distToObs < decisionZone || tRex.jumping) {
                    var state = self.extractState(r);
                    var outputs = forward(state, demoNet);
                    var bestAction = 0;
                    if (outputs[1] > outputs[bestAction]) bestAction = 1;
                    if (outputs[2] > outputs[bestAction]) bestAction = 2;
                    self.executeAction(bestAction, r);
                } else {
                    if (tRex.ducking) tRex.setDuck(false);
                }
            },
            onCrash: function () {
                demoEnding = true;
                // Don't call _endDemo here — tick() will handle it.
            },
            recordPrediction: function () {},
            checkGhostCollisions: function () {}
        };

        runner.aiAgent = demoAgent;
        runner.postRenderHook = null;
        runner.suppressCollision = false;

        // Reset runner for fresh demo.
        runner.playing = true;
        runner.crashed = false;
        runner.activated = true;
        runner.distanceRan = 0;
        runner.setSpeed(runner.config.SPEED);
        runner.time = performance.now() - frameDt;
        runner.containerEl.classList.remove('crashed');
        runner.distanceMeter.reset(runner.highestScore);
        runner.horizon.reset();
        runner.tRex.reset();
        runner.invert(true);

        // Poll stats during demo so the user sees the score ticking up.
        this._demoStatsInterval = setInterval(function () {
            if (self._trainPhase !== 'demo') {
                clearInterval(self._demoStatsInterval);
                self._demoStatsInterval = null;
                return;
            }
            self.updateStats();
        }, 200);

        function tick() {
            if (!self._trainingRunning || !self.enabled) return;
            if (self._trainPhase !== 'demo') return;

            // Check if demo should end (flag set by update or crash).
            // We handle it here, OUTSIDE of runner.update(), to avoid
            // re-entrance with gameOver() / state reset conflicts.
            if (demoEnding) {
                self._endDemo(runner, realAgent);
                return; // _endDemo starts silent phase
            }

            var now = performance.now();
            if (runner.time && (now - runner.time) > 100) {
                runner.time = now - frameDt;
            }

            runner.updatePending = false;
            runner.update();

            // After update, check if demo ended (crash or score cap
            // set demoEnding=true inside runner.update).
            if (demoEnding) {
                // Defer to next frame to let runner.update() fully unwind.
                setTimeout(function () {
                    self._endDemo(runner, realAgent);
                }, 0);
                return;
            }

            if (self._trainPhase === 'demo' && self._trainingRunning) {
                // Use setTimeout (not rAF) so the demo isn't throttled
                // when the tab is in the background or not focused.
                setTimeout(tick, runner.slowMo ? 50 : 16);
            }
        }
        setTimeout(tick, runner.slowMo ? 50 : 16);
    };

    /** End the demo and transition back to silent training. */
    RLAgent.prototype._endDemo = function (runner, realAgent) {
        if (this._trainPhase !== 'demo') return;
        // Clear demo stats interval.
        if (this._demoStatsInterval) {
            clearInterval(this._demoStatsInterval);
            this._demoStatsInterval = null;
        }
        // Restore real training agent.
        runner.aiAgent = realAgent;
        runner.postRenderHook = realAgent.drawGhosts
            ? realAgent.drawGhosts.bind(realAgent) : null;
        // Restore parallel mode collision suppression (demo disabled it).
        runner.suppressCollision = this.parallelMode;
        // Reset runner for training.
        runner.playing = true;
        runner.crashed = false;
        runner.activated = true;
        runner.distanceRan = 0;
        if (this._dualSpeedEval) {
            // Set up for pass 1: MAX_SPEED=13 so pterodactyls spawn.
            // Don't re-save _savedMaxSpeed — evolve() already saved the
            // real MAX_SPEED (e.g. 50) before setting 13 for pass 1.
            runner.config.MAX_SPEED = 13;
            runner.setSpeed(runner.config.SPEED);
            runner.currentSpeed = runner.config.SPEED;
        } else {
            runner.setSpeed(runner.config.SPEED);
        }
        runner.time = performance.now() - (1000 / 60);
        runner.containerEl.classList.remove('crashed');
        runner.distanceMeter.reset(runner.highestScore);
        runner.horizon.reset();
        runner.horizon.obstacles = [];
        runner.tRex.reset();
        runner.invert(true);
        // Resume silent training.
        this._silentGensRemaining = this._silentGenTarget;
        this._startSilentPhase();
    };

    /**
     * Silent phase: train as fast as possible with no rendering.
     * Uses MessageChannel pump (not throttled in background tabs).
     */
    RLAgent.prototype._startSilentPhase = function () {
        this._trainPhase = 'silent';
        this._skipRender = true;

        var self = this;
        // Use the hidden training runner (not the visible one).
        var runner = this._trainingRunner || this._runner;
        var frameDt = 1000 / 60;
        var channel = new MessageChannel();
        this._trainingChannel = channel;

        channel.port1.onmessage = function () {
            if (!self._trainingRunning || !self.enabled) return;
            if (self._trainPhase !== 'silent') return;

            // Run a batch of frames per tick for throughput.
            for (var i = 0; i < 100; i++) {
                // A phase transition may have happened inside runner.update()
                // (via checkGhostCollisions → evolve). Break out immediately.
                if (self._trainPhase !== 'silent') break;

                if (runner.crashed || !runner.playing) {
                    runner.playing = true;
                    runner.crashed = false;
                    runner.activated = true;
                    runner.distanceRan = 0;
                    runner.setSpeed(runner.config.SPEED);
                    runner.time = performance.now() - frameDt;
                    runner.containerEl.classList.remove('crashed');
                    runner.distanceMeter.reset(runner.highestScore);
                    runner.horizon.reset();
                    runner.tRex.reset();
                    runner.invert(true);
                    continue;
                }
                runner.updatePending = false;
                runner.time = performance.now() - frameDt;
                runner.update();
            }

            if (self._trainPhase === 'silent' && self._trainingRunning) {
                channel.port2.postMessage(0);
            }
        };
        channel.port2.postMessage(0);
    };

    RLAgent.prototype._stopTrainingLoop = function () {
        this._trainingRunning = false;
        this._trainPhase = null;
        this._skipRender = false;
        if (this._trainingChannel) {
            this._trainingChannel.port1.close();
            this._trainingChannel.port2.close();
            this._trainingChannel = null;
        }
        if (this._demoStatsInterval) {
            clearInterval(this._demoStatsInterval);
            this._demoStatsInterval = null;
        }
        // Destroy hidden training runner.
        this._destroyTrainingRunner();
        // Clear replay state.
        this._replayGhosts = null;
        this._replayNets = null;
        this._replayAgent = null;
        if (this._replayStatsInterval) {
            clearInterval(this._replayStatsInterval);
            this._replayStatsInterval = null;
        }
        // Restore original onCrash if we swapped it for watch mode.
        if (this._origOnCrash) {
            this.onCrash = this._origOnCrash;
            this._origOnCrash = null;
        }
        // Restore original runner.update and scheduleNextUpdate if we wrapped them.
        var runner = this._runner;
        if (runner && this._origRunnerUpdate) {
            runner.update = this._origRunnerUpdate;
            this._origRunnerUpdate = null;
        }
        if (runner && this._origScheduleNextUpdate) {
            runner.scheduleNextUpdate = this._origScheduleNextUpdate;
            this._origScheduleNextUpdate = null;
        }
        if (this._crashRestartTimer) {
            clearTimeout(this._crashRestartTimer);
            this._crashRestartTimer = null;
        }
        // Restore acceleration overridden for training.
        if (runner && this._savedAcceleration !== undefined) {
            runner.config.ACCELERATION = this._savedAcceleration;
            this._savedAcceleration = undefined;
        }
        // Restore MAX_SPEED if saved (dual-speed pass 1 override).
        if (runner && this._savedMaxSpeed !== undefined) {
            runner.config.MAX_SPEED = this._savedMaxSpeed;
            this._savedMaxSpeed = undefined;
        }
    };

    // -------------------------------------------------------------------------
    // Viewer / Comparison UI helpers
    // -------------------------------------------------------------------------

    /** Populate all snapshot dropdown selectors on the page. */
    RLAgent.prototype.populateSnapshotDropdowns = function () {
        var selects = document.querySelectorAll('.gen-select');
        if (!selects.length) return;
        var snaps = this.generationSnapshots;
        var isStrategy;
        for (var s = 0; s < selects.length; s++) {
            var sel = selects[s];
            var prev = sel.value;
            isStrategy = sel.id === 'strategy-gen-select';
            sel.innerHTML = '';
            // Strategy dropdown gets a "Current best" option.
            if (isStrategy) {
                var opt = document.createElement('option');
                opt.value = 'current';
                opt.textContent = 'Best overall';
                sel.appendChild(opt);
            }
            if (snaps.length === 0 && !isStrategy) {
                var opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'No snapshots yet';
                sel.appendChild(opt);
            }
            for (var i = snaps.length - 1; i >= 0; i--) {
                var opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = 'Gen ' + snaps[i].gen + '  (Best: ' + snaps[i].fitness + ')';
                sel.appendChild(opt);
            }
            if (prev) sel.value = prev;
        }
    };

    /** Get snapshot data by dropdown index. */
    RLAgent.prototype.getSnapshot = function (idx) {
        idx = parseInt(idx, 10);
        if (isNaN(idx) || idx < 0 || idx >= this.generationSnapshots.length) return null;
        return this.generationSnapshots[idx];
    };

    /** Get the best current network (elite 0 of latest population). */
    RLAgent.prototype.getBestNetwork = function () {
        // Sort population copy by fitness to find best
        var sorted = this.population.slice().sort(function (a, b) { return b.fitness - a.fitness; });
        return serializeNetwork(sorted[0].net);
    };

    // -------------------------------------------------------------------------
    // Post-render hook for drawing ghosts on the game canvas
    // -------------------------------------------------------------------------

    RLAgent.prototype.drawGhosts = function (ctx, runner) {
        if (!this.parallelMode || !this._ghostsInitialized) return;
        if (!this.ghosts || this.ghosts.length === 0) return;
        if (this._skipRender) return;

        // Find best alive for highlight.
        var bestAliveIdx = -1;
        var bestAliveFitness = -1;
        for (var i = 0; i < this.ghosts.length; i++) {
            if (this.ghosts[i].alive && this.ghosts[i].fitness > bestAliveFitness) {
                bestAliveFitness = this.ghosts[i].fitness;
                bestAliveIdx = this.ghosts[i].index;
            }
        }

        // During silent phase, only draw elites + best alive for performance.
        // During demo phase, ghosts aren't used (best net plays solo).
        var fastMode = this.speedMultiplier > 1 && this._trainPhase === 'silent';

        // Draw dead ghosts first (behind), then alive.
        for (var pass = 0; pass < 2; pass++) {
            for (var i = 0; i < this.ghosts.length; i++) {
                var ghost = this.ghosts[i];
                var isDead = !ghost.alive;
                if ((pass === 0 && !isDead) || (pass === 1 && isDead)) continue;

                // In fast mode, skip non-elite non-best ghosts.
                if (fastMode && ghost.alive &&
                    ghost.index !== bestAliveIdx && !ghost.isElite) continue;
                // In fast mode, skip dead ghost fade-outs entirely.
                if (fastMode && isDead) continue;

                ghost.draw(ctx, this._globalFrame, bestAliveIdx);
            }
        }
    };

    // =========================================================================
    // Global UI functions
    // =========================================================================

    window.rlAgent = null;

    window.initRL = function () {
        window.rlAgent = new RLAgent();
        window.rlAgent.updateStats();
        window.rlAgent.drawChart();
        window.rlAgent.populateSnapshotDropdowns();
    };

    window.toggleRL = function () {
        var agent = window.rlAgent;
        if (!agent) return;
        agent.enabled = !agent.enabled;
        var btn = document.getElementById('rl-toggle');
        if (btn) {
            if (agent.enabled) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        }
        var runner = window.evoRunner || Runner.instance_;
        agent._runner = runner;
        if (agent.enabled) {
            document.getElementById('ghost-legend').style.display = 'flex';

            // Cancel any pending frame on the visible runner.
            if (runner.raqId) {
                cancelAnimationFrame(runner.raqId);
                runner.raqId = 0;
                runner.updatePending = false;
            }
            runner.containerEl.style.width = runner.dimensions.WIDTH + 'px';
            runner.setArcadeMode();

            // setSpeedMultiplier creates the training runner and starts
            // both the fast background training AND the visual replay.
            agent.setSpeedMultiplier(agent.speedMultiplier);
        } else {
            // Stop the training loop.
            agent._stopTrainingLoop();
            if (runner) {
                runner.suppressCollision = false;
            }
            document.getElementById('ghost-legend').style.display = 'none';
        }
        if (window.updatePanelHighlights) window.updatePanelHighlights();
    };

    window.cycleSpeed = function () {
        // Kept for backwards compat — no-op since speed is always max.
    };

    // --- Strategy Analysis ---
    window.analyzeStrategy = function () {
        var agent = window.rlAgent;
        if (!agent) return;

        var out = document.getElementById('strategy-output');
        if (!out) return;

        // Determine which network to analyze based on dropdown selection.
        var bestNet = null;
        var bestFitness = 0;
        var source = '';
        var sel = document.getElementById('strategy-gen-select');
        var selVal = sel ? sel.value : 'current';

        if (selVal === 'current' || selVal === '') {
            // Use the best across current population AND all snapshots.
            for (var i = 0; i < agent.population.length; i++) {
                if (agent.population[i].fitness > bestFitness) {
                    bestFitness = agent.population[i].fitness;
                    bestNet = agent.population[i].net;
                    source = 'Gen ' + agent.generation + ' population';
                }
            }
            var snaps = agent.generationSnapshots;
            for (var i = 0; i < snaps.length; i++) {
                if (snaps[i].fitness > bestFitness) {
                    bestFitness = snaps[i].fitness;
                    var tmp = createNetwork(LAYER_SIZES);
                    deserializeNetwork(snaps[i].net, tmp);
                    bestNet = tmp;
                    source = 'Gen ' + snaps[i].gen;
                }
            }
        } else {
            // Use the specific snapshot selected.
            var idx = parseInt(selVal, 10);
            var snaps = agent.generationSnapshots;
            if (idx >= 0 && idx < snaps.length) {
                bestFitness = snaps[idx].fitness;
                var tmp = createNetwork(LAYER_SIZES);
                deserializeNetwork(snaps[idx].net, tmp);
                bestNet = tmp;
                source = 'Gen ' + snaps[idx].gen + ' snapshot';
            }
        }

        if (!bestNet || bestFitness === 0) {
            out.style.display = 'block';
            out.innerHTML = '<p style="color:#6e6e73;">No trained network yet. Hit TRAIN first!</p>';
            return;
        }

        var INPUT_NAMES = [
            'Time-to-impact 1',   // 0
            'Is pterodactyl 1',   // 1
            'Obstacle 1 Y pos',   // 2
            'Obstacle 1 width',   // 3
            'Time-to-impact 2',   // 4
            'Is pterodactyl 2',   // 5
            'Obstacle 2 Y pos',   // 6
            'Speed',              // 7
            'Jump height',        // 8
            'Is jumping',         // 9
            'Is ducking',         // 10
            'Obstacle 1 height'   // 11
        ];
        var ACTION_NAMES = ['RUN', 'JUMP', 'DUCK'];
        var ACTION_CLASSES = ['action-run', 'action-jump', 'action-duck'];

        var isSingleHidden = (bestNet.layers.length === 2);

        // --- Characterize each hidden neuron (single-hidden-layer only) ---
        var neurons = [], rules = [];
        if (isSingleHidden) {
            var L0 = bestNet.layers[0]; // input→hidden
            var L1 = bestNet.layers[1]; // hidden→output
            for (var h = 0; h < L0.rows; h++) {
                var weights = [];
                for (var j = 0; j < L0.cols; j++) {
                    weights.push({ name: INPUT_NAMES[j], w: L0.W[h * L0.cols + j], idx: j });
                }
                weights.sort(function (a, b) { return Math.abs(b.w) - Math.abs(a.w); });
                var outputs = [];
                for (var a = 0; a < L1.rows; a++) {
                    outputs.push({ action: ACTION_NAMES[a], w: L1.W[a * L1.cols + h], cls: ACTION_CLASSES[a] });
                }
                outputs.sort(function (a, b) { return Math.abs(b.w) - Math.abs(a.w); });
                neurons.push({ idx: h, bias: L0.b[h], weights: weights, outputs: outputs });
            }

            // Synthesize rules by tracing strongest paths.
            for (var a = 0; a < 3; a++) {
                var contributors = [];
                for (var h = 0; h < L1.cols; h++) {
                    var w = L1.W[a * L1.cols + h];
                    if (Math.abs(w) > 0.1) contributors.push({ h: h, w: w });
                }
                contributors.sort(function (a, b) { return Math.abs(b.w) - Math.abs(a.w); });
                var actionRules = [];
                for (var c = 0; c < Math.min(5, contributors.length); c++) {
                    var hi = contributors[c].h;
                    var sign = contributors[c].w > 0 ? 'excites' : 'inhibits';
                    var n = neurons[hi];
                    var triggers = [];
                    for (var t = 0; t < Math.min(3, n.weights.length); t++) {
                        var tw = n.weights[t];
                        if (Math.abs(tw.w) < 0.1) break;
                        triggers.push((tw.w > 0 ? '+' : '-') + tw.name + ' (' + tw.w.toFixed(2) + ')');
                    }
                    if (triggers.length > 0) {
                        actionRules.push({ neuron: hi, sign: sign, strength: Math.abs(contributors[c].w).toFixed(2), triggers: triggers });
                    }
                }
                rules.push({ action: ACTION_NAMES[a], cls: ACTION_CLASSES[a], bias: L1.b[a], rules: actionRules });
            }
        }

        // --- Test specific scenarios (works for any depth) ---
        function runNet(state) {
            var output = forward(state, bestNet);
            var best = 0;
            for (var i = 1; i < output.length; i++) {
                if (output[i] > output[best]) best = i;
            }
            return { scores: Array.from(output).map(function(v) { return v.toFixed(2); }), action: ACTION_NAMES[best] };
        }

        var scenarios = [
            { name: 'Cactus far away', state: [0.8, 0, 0.5, 0.3, 1, 0, 0.5, 0.5, 0, 0, 0, 0.3] },
            { name: 'Cactus close — on ground', state: [0.15, 0, 0.5, 0.3, 1, 0, 0.5, 0.5, 0, 0, 0, 0.3] },
            { name: 'Cactus very close — on ground', state: [0.05, 0, 0.5, 0.3, 1, 0, 0.5, 0.5, 0, 0, 0, 0.3] },
            { name: 'High pterodactyl close (run under)', state: [0.15, 1, 0.33, 0.3, 1, 0, 0.5, 0.5, 0, 0, 0, 0.5] },
            { name: 'Low pterodactyl close (must duck)', state: [0.15, 1, 0.67, 0.3, 1, 0, 0.5, 0.5, 0, 0, 0, 0.5] },
            { name: 'Mid-jump, nothing ahead', state: [1.0, 0, 0.5, 0, 1, 0, 0.5, 0.5, 0.5, 1, 0, 0] },
            { name: 'Two cacti — both close', state: [0.1, 0, 0.5, 0.3, 0.25, 0, 0.5, 0.3, 0, 0, 0, 0.3] },
            { name: 'High speed, cactus medium distance', state: [0.12, 0, 0.5, 0.3, 1, 0, 0.5, 0.9, 0, 0, 0, 0.3] },
        ];

        // --- Build HTML ---
        var html = '<div class="strategy-output">';
        html += '<h4>Best Network: ' + source + ' (fitness: ' + bestFitness + ')</h4>';

        // Scenario tests.
        html += '<h4>Decision Tests</h4>';
        for (var s = 0; s < scenarios.length; s++) {
            var result = runNet(scenarios[s].state);
            html += '<div class="strategy-rule">';
            html += '<strong>' + scenarios[s].name + '</strong> &rarr; ';
            html += '<span class="' + ACTION_CLASSES[ACTION_NAMES.indexOf(result.action)] + '">' + result.action + '</span>';
            html += ' <span style="color:#6e6e73;font-size:11px;">[R:' + result.scores[0] + ' J:' + result.scores[1] + ' D:' + result.scores[2] + ']</span>';
            html += '</div>';
        }

        // Per-action breakdown (single-hidden-layer only).
        if (isSingleHidden) {
            html += '<h4>Action Pathways</h4>';
            for (var a = 0; a < rules.length; a++) {
                var r = rules[a];
                html += '<div class="strategy-neuron">';
                html += '<span class="' + r.cls + '" style="font-weight:700;font-size:14px;">' + r.action + '</span>';
                html += ' <span style="color:#6e6e73;">(bias: ' + r.bias.toFixed(2) + ')</span><br>';
                for (var i = 0; i < r.rules.length; i++) {
                    var rule = r.rules[i];
                    html += '<span style="color:#6e6e73;">H' + rule.neuron + '</span> ';
                    html += (rule.sign === 'excites'
                        ? '<span class="weight-pos">' + rule.sign + '</span>'
                        : '<span class="weight-neg">' + rule.sign + '</span>');
                    html += ' (' + rule.strength + ') &larr; ' + rule.triggers.join(', ') + '<br>';
                }
                html += '</div>';
            }
        } else {
            html += '<h4>Architecture</h4>';
            html += '<p style="color:#6e6e73;font-size:12px;">[' + bestNet.sizes.join(', ') + '] (' + countParams(bestNet) + ' params, ' + bestNet.layers.length + ' layers)</p>';
        }

        // --- Distill decision boundaries ---
        html += '<h4>Distilled Decision Boundaries</h4>';
        html += '<p style="color:#6e6e73;font-size:12px;">Sweeping time-to-impact from 1.0→0.0 to find when the network switches actions:</p>';

        var obstacleTypes = [
            { name: 'Cactus (small)', isPtero: 0, yPos: 0.5, width: 0.17, height: 0.35 },
            { name: 'Cactus (large)', isPtero: 0, yPos: 0.5, width: 0.5, height: 0.5 },
            { name: 'Ptero HIGH (run under)', isPtero: 1, yPos: 0.33, width: 0.3, height: 0.4 },
            { name: 'Ptero MED', isPtero: 1, yPos: 0.50, width: 0.3, height: 0.4 },
            { name: 'Ptero LOW (must duck)', isPtero: 1, yPos: 0.67, width: 0.3, height: 0.4 }
        ];

        var distilledRules = [];

        for (var t = 0; t < obstacleTypes.length; t++) {
            var ot = obstacleTypes[t];
            var prevAction = null;
            var transitions = [];

            // Sweep time-to-impact from far (1.0) to close (0.0).
            for (var tti = 100; tti >= 0; tti--) {
                var ttiNorm = tti / 100;
                var testState = [
                    ttiNorm, ot.isPtero, ot.yPos, ot.width,
                    1.0, 0, 0.5,     // obs2 far away
                    0.5,              // medium speed
                    0, 0, 0,          // on ground, not jumping, not ducking
                    ot.height
                ];
                var result = runNet(testState);
                if (prevAction !== null && result.action !== prevAction) {
                    transitions.push({
                        from: prevAction,
                        to: result.action,
                        at: ttiNorm
                    });
                }
                prevAction = result.action;
            }

            html += '<div class="strategy-rule">';
            html += '<strong>' + ot.name + ':</strong> ';
            if (transitions.length === 0) {
                html += 'Always <span class="' + ACTION_CLASSES[ACTION_NAMES.indexOf(prevAction)] + '">' + prevAction + '</span>';
            } else {
                for (var tr = 0; tr < transitions.length; tr++) {
                    var trans = transitions[tr];
                    var frames = Math.round(trans.at * 30);
                    html += '<span class="' + ACTION_CLASSES[ACTION_NAMES.indexOf(trans.from)] + '">' + trans.from + '</span>';
                    html += ' &rarr; <span class="' + ACTION_CLASSES[ACTION_NAMES.indexOf(trans.to)] + '">' + trans.to + '</span>';
                    html += ' at tti=' + trans.at.toFixed(2) + ' (~' + frames + ' frames)';
                    if (tr < transitions.length - 1) html += ', then ';
                }
                // Record for simple agent.
                distilledRules.push({
                    type: ot.name,
                    isPtero: ot.isPtero,
                    yPos: ot.yPos,
                    transitions: transitions,
                    finalAction: prevAction
                });
            }
            html += '</div>';
        }

        // --- Generate simple agent code ---
        html += '<h4>Minimal Rule Agent</h4>';
        html += '<p style="color:#6e6e73;font-size:12px;">A ~10-line agent distilled from the neural network above. Click to run it:</p>';

        // Extract key thresholds from distilled rules.
        var jumpThreshold = 0.5;  // default
        var duckThreshold = 0.5;
        var pteroHighAction = 'RUN';

        for (var i = 0; i < distilledRules.length; i++) {
            var dr = distilledRules[i];
            for (var tr = 0; tr < dr.transitions.length; tr++) {
                if (dr.transitions[tr].to === 'JUMP' && !dr.isPtero) {
                    jumpThreshold = dr.transitions[tr].at;
                }
                if (dr.transitions[tr].to === 'DUCK' && dr.isPtero) {
                    duckThreshold = dr.transitions[tr].at;
                }
            }
            // Check what the network does for high ptero.
            if (dr.isPtero && dr.yPos < 0.4) {
                pteroHighAction = dr.finalAction;
            }
        }

        // Store thresholds globally for the simple agent.
        window._simpleAgentRules = {
            jumpThreshold: jumpThreshold,
            duckThreshold: duckThreshold,
            pteroHighAction: pteroHighAction
        };

        var ruleCode =
            'if (jumping) → do nothing\n' +
            'if (cactus && tti < ' + jumpThreshold.toFixed(2) + ') → JUMP\n' +
            'if (ptero && yPos > 0.4 && tti < ' + duckThreshold.toFixed(2) + ') → DUCK\n' +
            'if (ptero && yPos ≤ 0.4) → ' + pteroHighAction + '\n' +
            'else → RUN';

        html += '<div class="strategy-neuron" style="white-space:pre;line-height:1.8;">' + ruleCode + '</div>';

        html += '</div>';

        out.innerHTML = html;
        out.style.display = 'block';
    };

    // =========================================================================
    // Knowledge Distillation — train smaller networks to match the teacher
    // =========================================================================

    var _distilledStudents = [];
    var _distillDataset = null;       // cached dataset for re-use by direct training
    var _distillRawDataset = null;    // original 12-input dataset (before projection)
    var _distillProjectionKey = 'identity';
    var _lastInputImportance = null;
    var _activeProjectionKey = 'identity';
    var _distillPlayerRunning = false;
    var _distillPlayerTimer = null;
    var _distillPlayerOrigSchedule = null;
    var _distillPlayerDeaths = 0;
    var _distillPlayerBest = 0;
    var _distillPlayerNet = null;

    // --- Input projection registry ---
    // Each projection maps the 12-input state vector to a smaller input.
    var INPUT_NAMES_SHORT = [
        'TTI1', 'isPtero1', 'yPos1', 'width1', 'TTI2', 'isPtero2',
        'yPos2', 'speed', 'jumpH', 'isJump', 'isDuck', 'height1'
    ];
    var INPUT_PROJECTIONS = {
        identity: {
            label: '12 inputs (full)',
            size: 12,
            project: function (s) { return s; },
            names: INPUT_NAMES_SHORT
        },
        drop2: {
            label: '10 inputs (drop width1, yPos2)',
            size: 10,
            // Drop idx 3 (obs1 width) and idx 6 (obs2 yPos) — likely least important.
            indices: [0, 1, 2, 4, 5, 7, 8, 9, 10, 11],
            project: function (s) {
                var idx = this.indices;
                var out = new Float64Array(idx.length);
                for (var i = 0; i < idx.length; i++) out[i] = s[idx[i]];
                return out;
            },
            names: ['TTI1', 'isPtero1', 'yPos1', 'TTI2', 'isPtero2', 'speed', 'jumpH', 'isJump', 'isDuck', 'height1']
        },
        compact8: {
            label: '8 inputs (compact)',
            size: 8,
            // Keep: TTI1(0), isPtero1(1), yPos1(2), height1(11), TTI2(4), speed(7), jumpH(8), isJump(9)
            indices: [0, 1, 2, 11, 4, 7, 8, 9],
            project: function (s) {
                var idx = this.indices;
                var out = new Float64Array(idx.length);
                for (var i = 0; i < idx.length; i++) out[i] = s[idx[i]];
                return out;
            },
            names: ['TTI1', 'isPtero1', 'yPos1', 'height1', 'TTI2', 'speed', 'jumpH', 'isJump']
        }
    };

    /**
     * Main entry point: prune the teacher network to smaller sizes,
     * then fine-tune each with Hinton distillation on a synthetic dataset.
     */
    window.distillNetwork = function () {
        var agent = window.rlAgent;
        if (!agent) return;
        var out = document.getElementById('distill-output');
        if (!out) return;

        // Read projection from dropdown.
        var projSel = document.getElementById('input-projection-select');
        _activeProjectionKey = projSel ? projSel.value : 'identity';

        // Stop distilled player or RL training if running.
        if (_distillPlayerRunning) _stopDistillPlayer();
        if (agent.enabled) window.toggleRL();
        if (window.stopSimAI) window.stopSimAI();

        // Find best teacher across population + all snapshots.
        var teacherNet = null;
        var teacherFitness = 0;
        for (var i = 0; i < agent.population.length; i++) {
            if (agent.population[i].fitness > teacherFitness) {
                teacherFitness = agent.population[i].fitness;
                teacherNet = agent.population[i].net;
            }
        }
        for (var i = 0; i < agent.generationSnapshots.length; i++) {
            if (agent.generationSnapshots[i].fitness > teacherFitness) {
                teacherFitness = agent.generationSnapshots[i].fitness;
                var tmp = createNetwork(LAYER_SIZES);
                deserializeNetwork(agent.generationSnapshots[i].net, tmp);
                teacherNet = tmp;
            }
        }
        if (!teacherNet || teacherFitness === 0) {
            out.style.display = 'block';
            out.innerHTML = '<div class="strategy-output"><p style="color:#6e6e73;">No trained network yet. Train first!</p></div>';
            return;
        }

        var teacher = cloneNetwork(teacherNet);
        var teacherParams = countParams(teacher);
        out.style.display = 'block';
        out.innerHTML = '<div class="strategy-output"><p>Pruning teacher (' +
            teacherParams + ' params, fitness ' + teacherFitness + ') and fine-tuning...</p></div>';

        // Collect real gameplay data by running the teacher in the actual game.
        var statusP = out.querySelector('p');
        var projKey = _activeProjectionKey || 'identity';
        _collectGameplayDataset(teacher, function (dataset) {
            if (!dataset || dataset.length < 100) {
                out.innerHTML = '<div class="strategy-output"><p style="color:#ff3b30;">Failed to collect enough gameplay data (' +
                    (dataset ? dataset.length : 0) + ' samples). Is the game running?</p></div>';
                return;
            }

            // Run input importance analysis on the raw 12-input data.
            _distillRawDataset = dataset;
            _lastInputImportance = _analyzeInputImportance(teacher, dataset);

            // Apply input projection to dataset if not identity.
            var proj = INPUT_PROJECTIONS[projKey];
            var projDataset = dataset;
            if (proj && proj.size < 12) {
                projDataset = [];
                for (var i = 0; i < dataset.length; i++) {
                    projDataset.push({
                        input: proj.project(dataset[i].input),
                        soft: dataset[i].soft,
                        label: dataset[i].label
                    });
                }
            }

            var nIn = proj ? proj.size : 12;

            // Architecture list: single-hidden + multi-layer.
            var architectures = [
                [nIn, 16, 3], [nIn, 14, 3], [nIn, 12, 3],
                [nIn, 8, 3], [nIn, 6, 3],
                [nIn, 10, 6, 3], [nIn, 8, 4, 3], [nIn, 6, 6, 3], [nIn, 6, 4, 3]
            ];
            _distilledStudents = [];
            _distillDataset = projDataset;
            _distillProjectionKey = projKey;

            _distillNext(architectures, 0, projDataset, teacher, teacherFitness, teacherParams, out);
        }, statusP);
    };

    /** Process one architecture at a time (non-blocking via setTimeout). */
    function _distillNext(architectures, idx, dataset, teacher, teacherFitness, teacherParams, out) {
        if (idx >= architectures.length) {
            // Sort by param count ascending for easy comparison.
            _distilledStudents.sort(function (a, b) { return a.params - b.params; });
            _displayDistillResults(out, _distilledStudents, teacherFitness, teacherParams, dataset.length);
            return;
        }
        var arch = architectures[idx];
        out.innerHTML = '<div class="strategy-output"><p>Training [' +
            arch.join(', ') + '] ... (' + (idx + 1) + '/' + architectures.length + ')</p></div>';

        setTimeout(function () {
            // Scale epochs by total hidden capacity (teacher has 20 hidden neurons).
            var hiddenSum = 0;
            for (var k = 1; k < arch.length - 1; k++) hiddenSum += arch[k];
            var epochs = Math.max(300, Math.round(600 * (20 / hiddenSum)));

            var resultA = null, resultB = null;

            // Path A: Prune teacher — only for single-hidden-layer with same input size.
            if (arch.length === 3 && arch[0] === teacher.sizes[0]) {
                var pruned = _pruneNetwork(teacher, arch[1]);
                resultA = _fineTuneStudent(pruned, dataset, epochs);
            }

            // Path B: Train from random initialization (full distillation).
            var fresh = createNetwork(arch);
            resultB = _fineTuneStudent(fresh, dataset, epochs);

            // Keep whichever achieves higher agreement.
            var result, method;
            if (resultA && resultA.agreement >= resultB.agreement) {
                result = resultA; method = 'pruned';
            } else {
                result = resultB; method = 'scratch';
            }

            _distilledStudents.push({
                arch: arch,
                net: result.net,
                params: countParams(result.net),
                mse: 0,
                agreement: result.agreement,
                method: method,
                projectionKey: _distillProjectionKey || 'identity'
            });
            _distillNext(architectures, idx + 1, dataset, teacher, teacherFitness, teacherParams, out);
        }, 10);
    }

    /**
     * Prune a teacher network by removing least important hidden neurons.
     * Importance = L1-norm of outgoing weights × L1-norm of incoming weights.
     */
    function _pruneNetwork(teacherNet, targetHidden) {
        var L0 = teacherNet.layers[0]; // [nHidden × nInput]
        var L1 = teacherNet.layers[1]; // [nOutput × nHidden]
        var nHidden = L0.rows;
        var nInput = L0.cols;
        var nOutput = L1.rows;

        // Rank neurons by importance.
        var importance = [];
        for (var h = 0; h < nHidden; h++) {
            var outScore = 0;
            for (var a = 0; a < nOutput; a++) {
                outScore += Math.abs(L1.W[a * nHidden + h]);
            }
            var inScore = 0;
            for (var j = 0; j < nInput; j++) {
                inScore += Math.abs(L0.W[h * nInput + j]);
            }
            importance.push({ idx: h, score: outScore * inScore });
        }
        importance.sort(function (a, b) { return b.score - a.score; });

        // Keep top targetHidden neurons.
        var keepIdx = [];
        for (var i = 0; i < targetHidden; i++) keepIdx.push(importance[i].idx);
        keepIdx.sort(function (a, b) { return a - b; }); // preserve order

        // Build pruned network by copying selected weights.
        var prunedNet = createNetwork([nInput, targetHidden, nOutput]);
        var pL0 = prunedNet.layers[0];
        var pL1 = prunedNet.layers[1];

        for (var pH = 0; pH < targetHidden; pH++) {
            var origH = keepIdx[pH];
            // Input-to-hidden weights + bias.
            for (var j = 0; j < nInput; j++) {
                pL0.W[pH * nInput + j] = L0.W[origH * nInput + j];
            }
            pL0.b[pH] = L0.b[origH];
            // Hidden-to-output weights.
            for (var a = 0; a < nOutput; a++) {
                pL1.W[a * targetHidden + pH] = L1.W[a * nHidden + origH];
            }
        }
        // Output biases.
        for (var a = 0; a < nOutput; a++) pL1.b[a] = L1.b[a];

        return prunedNet;
    }

    /** Numerically stable softmax with temperature. */
    function _softmax(logits, T) {
        var n = logits.length;
        var out = new Float64Array(n);
        var maxVal = -Infinity;
        for (var i = 0; i < n; i++) {
            var v = logits[i] / T;
            if (v > maxVal) maxVal = v;
        }
        var sum = 0;
        for (var i = 0; i < n; i++) {
            out[i] = Math.exp(logits[i] / T - maxVal);
            sum += out[i];
        }
        for (var i = 0; i < n; i++) out[i] /= sum;
        return out;
    }

    /**
     * Analyze input importance by perturbation: for each of the 12 inputs,
     * perturb by ±0.2 and measure average output change across the dataset.
     * Returns ranked array [{idx, name, importance}].
     */
    function _analyzeInputImportance(teacher, dataset) {
        var nInputs = 12;
        var delta = 0.2;
        var importance = [];
        for (var idx = 0; idx < nInputs; idx++) {
            var totalChange = 0;
            for (var d = 0; d < dataset.length; d++) {
                var input = dataset[d].input;
                var baseOut = forward(input, teacher);

                // Perturb +delta.
                var perturbed = new Float64Array(input);
                perturbed[idx] = Math.min(1, perturbed[idx] + delta);
                var outPlus = forward(perturbed, teacher);

                // Perturb -delta.
                perturbed[idx] = Math.max(0, input[idx] - delta);
                var outMinus = forward(perturbed, teacher);

                // Sum absolute output changes.
                for (var o = 0; o < baseOut.length; o++) {
                    totalChange += Math.abs(outPlus[o] - baseOut[o]) + Math.abs(outMinus[o] - baseOut[o]);
                }
            }
            importance.push({
                idx: idx,
                name: INPUT_NAMES_SHORT[idx],
                importance: totalChange / dataset.length
            });
        }
        importance.sort(function (a, b) { return b.importance - a.importance; });
        return importance;
    }

    /**
     * Collect distillation dataset by running the teacher in the actual game.
     * Records every extractState + teacher output during live gameplay.
     * Calls back with the dataset when enough data is collected.
     */
    function _collectGameplayDataset(teacher, callback, statusEl) {
        var TEMP = 3;
        var dataset = [];
        var TARGET_FRAMES = 6000; // ~100 seconds at 60fps, enough for high-speed play
        var frameCount = 0;
        var runner = window.distillRunner || Runner.instance_;
        if (!runner) { callback([]); return; }

        if (statusEl) statusEl.textContent = 'Collecting gameplay data (0/' + TARGET_FRAMES + ')...';

        // Create a wrapper that plays the teacher and records states.
        var wrapper = {
            enabled: true,
            update: function (r) {
                if (!wrapper.enabled || !r.playing) return;
                var tRex = r.tRex;
                if (tRex.jumping && tRex.ducking) tRex.setDuck(false);

                var obstacles = r.horizon.obstacles;
                var speed = r.currentSpeed;
                var distToObs = 9999;
                for (var i = 0; i < obstacles.length; i++) {
                    var o = obstacles[i];
                    if (o.xPos + o.typeConfig.width * o.size > tRex.xPos) {
                        distToObs = o.xPos - tRex.xPos;
                        break;
                    }
                }
                var decisionZone = Math.max(DECISION_ZONE_BASE, speed * 10);
                if (distToObs < decisionZone || tRex.jumping) {
                    var rlAgent = window.rlAgent;
                    var state = rlAgent.extractState(r);
                    var output = forward(state, teacher);
                    // Record for dataset.
                    var soft = _softmax(output, TEMP);
                    var label = 0;
                    if (output[1] > output[label]) label = 1;
                    if (output[2] > output[label]) label = 2;
                    dataset.push({ input: new Float64Array(state), soft: soft, label: label });
                    // Execute teacher's action.
                    var bestAction = label;
                    rlAgent.executeAction(bestAction, r);
                }

                frameCount++;
                if (frameCount % 300 === 0 && statusEl) {
                    statusEl.textContent = 'Collecting gameplay data (' + frameCount + '/' + TARGET_FRAMES +
                        ', ' + dataset.length + ' samples, score ' + Math.round(r.distanceRan * 0.025) + ')...';
                }
                if (frameCount >= TARGET_FRAMES && wrapper.enabled) {
                    // Stop collection (guard against double-fire).
                    wrapper.enabled = false;
                    runner.aiAgent = null;
                    if (statusEl) statusEl.textContent = 'Collected ' + dataset.length + ' samples. Training...';
                    setTimeout(function () { callback(dataset); }, 30);
                }
            },
            onCrash: function () {
                // Teacher crashed — unusual but handle gracefully.
            },
            recordPrediction: function () {},
            checkGhostCollisions: function () {}
        };

        runner.aiAgent = wrapper;
        runner.postRenderHook = null;
        runner.suppressCollision = false;

        if (runner.crashed) {
            runner.restart();
            runner.tRex.startJump(runner.currentSpeed);
        } else if (!runner.playing) {
            runner.loadSounds();
            runner.playing = true;
            runner.activated = true;
            runner.tRex.playingIntro = false;
            runner.playingIntro = false;
            runner.setArcadeMode();
            runner.containerEl.style.width = runner.dimensions.WIDTH + 'px';
            runner.tRex.startJump(runner.currentSpeed);
            runner.update();
        }
    }

    /**
     * Fine-tune a student via Hinton distillation — supports arbitrary depth.
     * Generic N-layer forward + backward pass.
     */
    function _fineTuneStudent(net, dataset, nEpochs) {
        var TEMP = 3;
        var nLayers = net.layers.length; // number of weight matrices
        var nData = dataset.length;
        var batchSize = 32;
        var lr = 0.01;

        // Pre-allocate gradient accumulators per layer.
        var gW = [], gb = [];
        for (var l = 0; l < nLayers; l++) {
            gW.push(new Float64Array(net.layers[l].W.length));
            gb.push(new Float64Array(net.layers[l].b.length));
        }

        // Shuffle indices.
        var indices = [];
        for (var i = 0; i < nData; i++) indices.push(i);

        for (var epoch = 0; epoch < nEpochs; epoch++) {
            // Fisher-Yates shuffle.
            for (var i = nData - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
            }

            for (var bStart = 0; bStart < nData; bStart += batchSize) {
                var bEnd = Math.min(bStart + batchSize, nData);
                var bSize = bEnd - bStart;
                for (var l = 0; l < nLayers; l++) { gW[l].fill(0); gb[l].fill(0); }

                for (var s = bStart; s < bEnd; s++) {
                    var d = indices[s];
                    var input = dataset[d].input;
                    var teacherSoft = dataset[d].soft;

                    // --- Forward pass: cache activations and pre-activations ---
                    var acts = [input]; // acts[0] = input, acts[l+1] = output of layer l
                    var preActs = [];   // preActs[l] = W*x + b before activation
                    var x = input;
                    for (var l = 0; l < nLayers; l++) {
                        var L = net.layers[l];
                        var z = new Float64Array(L.rows);
                        for (var r = 0; r < L.rows; r++) {
                            var sum = L.b[r];
                            var off = r * L.cols;
                            for (var c = 0; c < L.cols; c++) sum += L.W[off + c] * x[c];
                            z[r] = sum;
                        }
                        preActs.push(z);
                        if (l < nLayers - 1) {
                            // Hidden layer: ReLU
                            var a = new Float64Array(z.length);
                            for (var r = 0; r < z.length; r++) a[r] = z[r] > 0 ? z[r] : 0;
                            acts.push(a);
                            x = a;
                        } else {
                            // Output layer: linear
                            acts.push(z);
                            x = z;
                        }
                    }

                    // --- Output gradient: Hinton distillation ---
                    var logits = preActs[nLayers - 1];
                    var studentSoft = _softmax(logits, TEMP);
                    var nOutput = logits.length;
                    var delta = new Float64Array(nOutput);
                    for (var o = 0; o < nOutput; o++) {
                        delta[o] = TEMP * (studentSoft[o] - teacherSoft[o]);
                    }

                    // --- Backward pass: accumulate gradients layer by layer ---
                    for (var l = nLayers - 1; l >= 0; l--) {
                        var L = net.layers[l];
                        var inp = acts[l]; // input to this layer

                        // Accumulate weight and bias gradients.
                        for (var r = 0; r < L.rows; r++) {
                            gb[l][r] += delta[r];
                            var off = r * L.cols;
                            for (var c = 0; c < L.cols; c++) {
                                gW[l][off + c] += delta[r] * inp[c];
                            }
                        }

                        // Backprop delta to previous layer (skip for first layer).
                        if (l > 0) {
                            var prevDelta = new Float64Array(L.cols);
                            for (var c = 0; c < L.cols; c++) {
                                // ReLU gate: if pre-activation <= 0, gradient is 0
                                if (preActs[l - 1][c] <= 0) continue;
                                var g = 0;
                                for (var r = 0; r < L.rows; r++) {
                                    g += L.W[r * L.cols + c] * delta[r];
                                }
                                prevDelta[c] = g;
                            }
                            delta = prevDelta;
                        }
                    }
                }

                // Apply averaged gradients.
                var scale = lr / bSize;
                for (var l = 0; l < nLayers; l++) {
                    var L = net.layers[l];
                    for (var i = 0; i < L.W.length; i++) L.W[i] -= scale * gW[l][i];
                    for (var i = 0; i < L.b.length; i++) L.b[i] -= scale * gb[l][i];
                }
            }

            // Learning rate decay.
            if (epoch === Math.floor(nEpochs * 0.5)) lr *= 0.3;
            if (epoch === Math.floor(nEpochs * 0.75)) lr *= 0.3;
        }

        // Final evaluation: agreement on hard labels.
        var agree = 0;
        for (var d = 0; d < nData; d++) {
            var out = forward(dataset[d].input, net);
            var sB = 0;
            if (out[1] > out[sB]) sB = 1;
            if (out[2] > out[sB]) sB = 2;
            if (sB === dataset[d].label) agree++;
        }

        return { net: net, mse: 0, agreement: agree / nData };
    }

    /** Render the results table with Play buttons. */
    function _displayDistillResults(out, students, teacherFitness, teacherParams, datasetSize) {
        var html = '<div class="strategy-output">';
        html += '<h4>Knowledge Distillation Results</h4>';
        var projLabel = INPUT_PROJECTIONS[_distillProjectionKey || 'identity'].label;
        html += '<p style="color:#6e6e73;font-size:12px;">Teacher: [' + LAYER_SIZES.join(', ') + '] (' +
            teacherParams + ' params, fitness ' + teacherFitness + '). Distilled on ' +
            datasetSize + ' gameplay samples (Hinton T=3). Inputs: ' + projLabel + '.</p>';

        // Input importance analysis.
        if (_lastInputImportance) {
            html += '<h4 style="margin-top:12px;margin-bottom:4px;">Input Importance (perturbation analysis)</h4>';
            html += '<div style="display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;margin-bottom:8px;">';
            var maxImp = _lastInputImportance[0].importance;
            for (var ii = 0; ii < _lastInputImportance.length; ii++) {
                var imp = _lastInputImportance[ii];
                var barW = Math.round((imp.importance / maxImp) * 60);
                var color = ii < 4 ? '#30d158' : ii < 8 ? '#ff9f0a' : '#ff3b30';
                html += '<div style="min-width:140px;"><span style="color:#6e6e73;">' + (ii + 1) + '.</span> ' +
                    '<b>' + imp.name + '</b> ' +
                    '<span style="display:inline-block;width:' + barW + 'px;height:8px;background:' + color + ';border-radius:2px;vertical-align:middle;"></span> ' +
                    '<span style="color:#6e6e73;">' + imp.importance.toFixed(2) + '</span></div>';
            }
            html += '</div>';
        }

        html += '<table style="width:100%;border-collapse:collapse;font-size:13px;margin:12px 0;">';
        html += '<tr style="border-bottom:2px solid #d2d2d7;">' +
            '<th style="text-align:left;padding:8px 6px;">Architecture</th>' +
            '<th style="text-align:right;padding:8px 6px;">Params</th>' +
            '<th style="text-align:right;padding:8px 6px;">Reduction</th>' +
            '<th style="text-align:right;padding:8px 6px;">Agreement</th>' +
            '<th style="text-align:right;padding:8px 6px;">Evo Best</th>' +
            '<th style="padding:8px 6px;"></th></tr>';

        for (var i = 0; i < students.length; i++) {
            var s = students[i];
            var reduction = Math.round((1 - s.params / teacherParams) * 100);
            var agreeColor = s.agreement > 0.98 ? '#30d158' :
                             s.agreement > 0.95 ? '#ff9f0a' : '#ff3b30';
            var agreePct = (s.agreement * 100).toFixed(1);
            var evoCell = s.evoBest != null
                ? '<span style="font-weight:600;">' + s.evoBest + '</span>'
                : '<button class="btn btn-small" onclick="directTrainStudent(' + i + ')" style="font-size:10px;">Direct</button>';

            html += '<tr style="border-bottom:1px solid #e8e8ed;">';
            html += '<td style="padding:8px 6px;font-family:monospace;font-size:12px;">[' + s.arch.join(', ') + ']</td>';
            html += '<td style="text-align:right;padding:8px 6px;">' + s.params + '</td>';
            html += '<td style="text-align:right;padding:8px 6px;color:#6e6e73;">-' + reduction + '%</td>';
            var methodTag = s.method === 'scratch' ? ' <span style="color:#6e6e73;font-weight:400;font-size:10px;">(scratch)</span>' : '';
            html += '<td style="text-align:right;padding:8px 6px;font-weight:600;color:' + agreeColor + ';">' + agreePct + '%' + methodTag + '</td>';
            html += '<td style="text-align:right;padding:8px 6px;">' + evoCell + '</td>';
            html += '<td style="padding:8px 6px;text-align:center;">' +
                '<button class="btn btn-small" onclick="playDistilledStudent(' + i + ')">Play</button></td>';
            html += '</tr>';
        }

        html += '</table>';
        html += '<p style="color:#6e6e73;font-size:11px;">Agreement = % of decisions matching teacher. Click <b>Play</b> to verify in-game. Click <b>Direct</b> to compare with evolution.</p>';
        html += '<div id="distill-play-status" style="margin-top:8px;font-size:13px;"></div>';
        html += '</div>';
        out.innerHTML = html;
    }

    // --- Play a distilled student live in the game ---
    // Uses the game's native aiAgent hook for correct timing (identical to training).

    function _stopDistillPlayer() {
        _distillPlayerRunning = false;
        if (_distillPlayerTimer) {
            clearInterval(_distillPlayerTimer);
            _distillPlayerTimer = null;
        }
        _distillPlayerNet = null;
        // Clear agent hooks on whichever runner was being used.
        var runners = [window.distillRunner, window.evoRunner];
        for (var ri = 0; ri < runners.length; ri++) {
            if (runners[ri]) {
                runners[ri].aiAgent = null;
                runners[ri].postRenderHook = null;
            }
        }
        var statusEl = document.getElementById('distill-play-status');
        if (statusEl) statusEl.textContent = '';
    }
    window.stopDistilledPlayer = _stopDistillPlayer;

    window.playDistilledStudent = function (idx) {
        if (!_distilledStudents || idx >= _distilledStudents.length) return;
        var runner = window.distillRunner || Runner.instance_;
        if (!runner) return;

        var student = _distilledStudents[idx];

        // Toggle off if same student is already playing.
        if (_distillPlayerRunning && _distillPlayerNet === student.net) {
            _stopDistillPlayer();
            return;
        }

        // Stop all other agents.
        _stopDistillPlayer();
        if (window.rlAgent && window.rlAgent.enabled) window.toggleRL();
        if (window._simAgent && window._simAgent.enabled) window.toggleSimAI();

        _distillPlayerNet = student.net;
        _distillPlayerRunning = true;
        _distillPlayerDeaths = 0;
        _distillPlayerBest = 0;

        var statusEl = document.getElementById('distill-play-status');
        if (statusEl) statusEl.textContent = 'Playing [' + student.arch.join(', ') + '] (' + student.params + ' params)...';

        var agent = window.rlAgent;
        var playNet = student.net;
        var studentProj = INPUT_PROJECTIONS[student.projectionKey || 'identity'];

        // Create a wrapper agent that hooks into the game's native update loop.
        // This guarantees identical timing to RL training.
        var lastCrashScore = 0;
        var wrapper = {
            enabled: true,
            update: function (r) {
                if (!_distillPlayerRunning || !r.playing) return;
                var tRex = r.tRex;
                var obstacles = r.horizon.obstacles;
                var speed = r.currentSpeed;

                // Decision zone — same as RL training.
                var distToObs = 9999;
                for (var i = 0; i < obstacles.length; i++) {
                    var o = obstacles[i];
                    if (o.xPos + o.typeConfig.width * o.size > tRex.xPos) {
                        distToObs = o.xPos - tRex.xPos;
                        break;
                    }
                }
                // Fix stuck ducking-during-jump state. The real tRex's
                // speed-drop-to-duck code (index.js line ~1786) can set
                // ducking=true while jumping=true, changing the animation
                // status to DUCKING. This makes msPerFrame=125 instead of
                // 16.67, slowing physics 7.5×. Ghosts never have this issue.
                if (tRex.jumping && tRex.ducking) {
                    tRex.setDuck(false);
                }

                var decisionZone = Math.max(DECISION_ZONE_BASE, speed * 10);
                if (distToObs < decisionZone || tRex.jumping) {
                    var state = agent.extractState(r);
                    if (studentProj && studentProj.size < 12) state = studentProj.project(state);
                    var outputs = forward(state, playNet);
                    var bestAction = 0;
                    if (outputs[1] > outputs[bestAction]) bestAction = 1;
                    if (outputs[2] > outputs[bestAction]) bestAction = 2;
                    agent.executeAction(bestAction, r);
                } else {
                    if (tRex.ducking) tRex.setDuck(false);
                }
            },
            // Called by gameOver() — record crash stats. The game's built-in
            // auto-restart (with initial jump) handles restarting.
            onCrash: function () {
                lastCrashScore = Math.round(runner.distanceRan * 0.025);
                if (lastCrashScore > _distillPlayerBest) _distillPlayerBest = lastCrashScore;
                _distillPlayerDeaths++;
                if (statusEl) statusEl.textContent = '[' + student.arch.join(', ') + '] Deaths: ' +
                    _distillPlayerDeaths + ' | Best: ' + _distillPlayerBest + ' | Last: ' + lastCrashScore;
            },
            recordPrediction: function () {},
            checkGhostCollisions: function () {}
        };

        runner.aiAgent = wrapper;
        runner.postRenderHook = null;
        runner.suppressCollision = false;

        // Start the game (or restart if stalled/crashed).
        if (runner.crashed) {
            runner.restart();
            runner.tRex.startJump(runner.currentSpeed);
        } else if (!runner.playing) {
            runner.loadSounds();
            runner.playing = true;
            runner.activated = true;
            runner.tRex.playingIntro = false;
            runner.playingIntro = false;
            runner.setArcadeMode();
            runner.containerEl.style.width = runner.dimensions.WIDTH + 'px';
            runner.tRex.startJump(runner.currentSpeed);
            runner.update();
        } else if (!runner.updatePending) {
            // Update loop stalled (e.g. tab was backgrounded during data collection).
            runner.update();
        }

        // Poll for live score display.
        _distillPlayerTimer = setInterval(function () {
            if (!_distillPlayerRunning) {
                clearInterval(_distillPlayerTimer);
                return;
            }
            if (!runner.crashed && statusEl) {
                var score = Math.round(runner.distanceRan * 0.025);
                if (score > _distillPlayerBest) _distillPlayerBest = score;
                statusEl.textContent = '[' + student.arch.join(', ') + '] Score: ' + score +
                    ' | Deaths: ' + _distillPlayerDeaths + ' | Best: ' + _distillPlayerBest;
            }
        }, 200);
    };

    // --- Direct Evolution Training (for comparison with distillation) ---
    // Runs a mini neuroevolution loop on the cached dataset to see if
    // evolution can match distillation quality for the same architecture.
    window.directTrainStudent = function (idx) {
        if (!_distilledStudents || idx >= _distilledStudents.length) return;
        if (!_distillDataset || _distillDataset.length < 100) return;

        var student = _distilledStudents[idx];
        var arch = student.arch;
        var dataset = _distillDataset;
        var statusEl = document.getElementById('distill-play-status');
        if (statusEl) statusEl.textContent = 'Evolving [' + arch.join(', ') + '] ... (0/30 generations)';

        var POP = 50;
        var GENS = 30;
        var ELITE = 5;
        var PARENTS = 10;
        var sigma = 0.3;

        // Initialize population with random networks.
        var pop = [];
        for (var i = 0; i < POP; i++) {
            pop.push({ net: createNetwork(arch), fitness: 0 });
        }

        // Evaluate fitness = agreement with teacher on dataset.
        function evalPop() {
            for (var p = 0; p < pop.length; p++) {
                var agree = 0;
                for (var d = 0; d < dataset.length; d++) {
                    var out = forward(dataset[d].input, pop[p].net);
                    var best = 0;
                    if (out[1] > out[best]) best = 1;
                    if (out[2] > out[best]) best = 2;
                    if (best === dataset[d].label) agree++;
                }
                pop[p].fitness = agree / dataset.length;
            }
        }

        var gen = 0;
        function runGen() {
            evalPop();
            pop.sort(function (a, b) { return b.fitness - a.fitness; });

            if (statusEl) statusEl.textContent = 'Evolving [' + arch.join(', ') + '] gen ' +
                (gen + 1) + '/' + GENS + ' — best agreement: ' + (pop[0].fitness * 100).toFixed(1) + '%';

            gen++;
            if (gen >= GENS) {
                // Done — record the result.
                var bestAgreement = pop[0].fitness;
                student.evoBest = (bestAgreement * 100).toFixed(1) + '%';
                student.evoNet = cloneNetwork(pop[0].net);
                // Re-render results table.
                var out = document.getElementById('distill-output');
                if (out) {
                    var teacherParams = countParams(window.rlAgent.population[0].net);
                    var teacherFitness = 0;
                    for (var p = 0; p < window.rlAgent.population.length; p++) {
                        if (window.rlAgent.population[p].fitness > teacherFitness) teacherFitness = window.rlAgent.population[p].fitness;
                    }
                    _displayDistillResults(out, _distilledStudents, teacherFitness, teacherParams, dataset.length);
                }
                if (statusEl) statusEl.textContent = 'Evolution done: [' + arch.join(', ') + '] best agreement = ' + (bestAgreement * 100).toFixed(1) + '%';
                return;
            }

            // Select & breed.
            var parents = pop.slice(0, PARENTS);
            var nextPop = [];
            for (var i = 0; i < ELITE; i++) {
                nextPop.push({ net: cloneNetwork(parents[i].net), fitness: 0 });
            }
            while (nextPop.length < POP) {
                var p1 = Math.floor(Math.random() * PARENTS);
                var child;
                if (Math.random() < 0.3 && PARENTS > 1) {
                    var p2 = p1;
                    while (p2 === p1) p2 = Math.floor(Math.random() * PARENTS);
                    child = crossoverNetworks(parents[p1].net, parents[p2].net);
                } else {
                    child = cloneNetwork(parents[p1].net);
                }
                mutateNetwork(child, sigma);
                nextPop.push({ net: child, fitness: 0 });
            }
            pop = nextPop;

            // Sigma decay.
            sigma = Math.max(0.01, sigma * 0.95);

            setTimeout(runGen, 5);
        }

        setTimeout(runGen, 5);
    };

    window.resetAgent = function () {
        var agent = window.rlAgent;
        if (!agent) return;

        // If training is active, stop it first.
        if (agent.enabled) {
            window.toggleRL();
        }

        agent.resetState();

        // Reset the game canvas so the user sees a clean idle state.
        var runner = window.evoRunner || Runner.instance_;
        if (runner) {
            if (runner.raqId) {
                cancelAnimationFrame(runner.raqId);
                runner.raqId = 0;
                runner.updatePending = false;
            }
            runner.crashed = false;
            runner.playing = false;
            runner.activated = false;
            runner.distanceRan = 0;
            runner.clearCanvas();
            runner.distanceMeter.reset(runner.highestScore);
            runner.horizon.reset();
            runner.horizon.update(0, 0, true);  // draw ground/clouds
            runner.tRex.reset();
            runner.tRex.update(0, Trex.status.WAITING);
            runner.update();
        }
        if (window.updatePanelHighlights) window.updatePanelHighlights();
    };

    // Update dropdowns when new snapshots arrive (after each generation save).
    var _origSaveState = RLAgent.prototype.saveState;
    RLAgent.prototype.saveState = function () {
        _origSaveState.call(this);
        this.populateSnapshotDropdowns();
    };

    // =========================================================================
    // Export / Import precomputed data
    // =========================================================================

    /** Export all training results as a JSON-serializable object. */
    window.exportPrecomputed = function () {
        var a = window.rlAgent;
        if (!a) return null;

        // Find best teacher from snapshots.
        var bestSnap = null;
        var bestFit = 0;
        for (var i = 0; i < a.generationSnapshots.length; i++) {
            if (a.generationSnapshots[i].fitness > bestFit) {
                bestFit = a.generationSnapshots[i].fitness;
                bestSnap = a.generationSnapshots[i];
            }
        }
        // Also check current population.
        for (var i = 0; i < a.population.length; i++) {
            if (a.population[i].fitness > bestFit) {
                bestFit = a.population[i].fitness;
                bestSnap = { gen: a.generation, fitness: bestFit, net: serializeNetwork(a.population[i].net) };
            }
        }
        if (!bestSnap) return null;

        // Training curve.
        var curve = a.generationBestHistory.slice();

        // Key snapshots (deduplicate by fitness improvements).
        var snaps = [];
        var lastFit = -1;
        for (var i = 0; i < a.generationSnapshots.length; i++) {
            var s = a.generationSnapshots[i];
            if (s.fitness > lastFit || i === 0 || i === a.generationSnapshots.length - 1) {
                snaps.push({ gen: s.gen, fitness: s.fitness, net: s.net });
                lastFit = s.fitness;
            }
        }

        // Distilled students.
        var students = [];
        for (var i = 0; i < _distilledStudents.length; i++) {
            var s = _distilledStudents[i];
            students.push({
                arch: s.arch,
                net: serializeNetwork(s.net),
                params: s.params,
                agreement: s.agreement,
                method: s.method || 'scratch',
                projectionKey: s.projectionKey || 'identity'
            });
        }

        return {
            teacher: { net: bestSnap.net, fitness: bestFit },
            trainingCurve: curve,
            snapshots: snaps,
            students: students,
            inputImportance: _lastInputImportance,
            metadata: {
                generations: a.generation,
                datasetSize: _distillDataset ? _distillDataset.length : 0,
                layerSizes: LAYER_SIZES.slice()
            }
        };
    };

    /** Load precomputed results for narrative mode. */
    window.loadPrecomputed = function () {
        var data = window.PRECOMPUTED;
        if (!data) return false;

        // Reconstruct teacher network.
        var teacherNet = createNetwork(data.teacher.net.sizes);
        deserializeNetwork(data.teacher.net, teacherNet);
        window._precomputedTeacher = { net: teacherNet, fitness: data.teacher.fitness };

        // Reconstruct distilled students.
        _distilledStudents = [];
        for (var i = 0; i < data.students.length; i++) {
            var s = data.students[i];
            var net = createNetwork(s.arch);
            deserializeNetwork(s.net, net);
            _distilledStudents.push({
                arch: s.arch, net: net, params: s.params,
                agreement: s.agreement, method: s.method, mse: 0,
                projectionKey: s.projectionKey || 'identity'
            });
        }

        // Load input importance.
        _lastInputImportance = data.inputImportance;
        _distillProjectionKey = 'identity';

        return true;
    };

    /** Play the precomputed teacher network live in the game. */
    window.playTeacherLive = function (maxSpeed) {
        var teacher = window._precomputedTeacher;
        if (!teacher) return;
        var runner = window.evoRunner || Runner.instance_;
        if (!runner) return;

        // Stop other agents on the same runner.
        if (_distillPlayerRunning) _stopDistillPlayer();

        _distillPlayerNet = teacher.net;
        _distillPlayerRunning = true;
        _distillPlayerDeaths = 0;
        _distillPlayerBest = 0;

        // Set max speed and starting speed for the "speed test" demo.
        if (maxSpeed) {
            runner.config.MAX_SPEED = maxSpeed;
            runner.config.SPEED = maxSpeed;
            runner.currentSpeed = maxSpeed;
        }

        var statusEl = document.getElementById('teacher-stats') ||
                       document.getElementById('distill-play-status');
        if (statusEl) statusEl.textContent = 'Playing teacher [12, 20, 3] (323 params)...';

        var agent = window.rlAgent;
        var playNet = teacher.net;
        var lastCrashScore = 0;

        var _nnVizFrame = 0;
        var wrapper = {
            enabled: true,
            update: function (r) {
                if (!_distillPlayerRunning || !r.playing) return;
                var tRex = r.tRex;
                var obstacles = r.horizon.obstacles;
                var speed = r.currentSpeed;

                var distToObs = 9999;
                for (var i = 0; i < obstacles.length; i++) {
                    var o = obstacles[i];
                    if (o.xPos + o.typeConfig.width * o.size > tRex.xPos) {
                        distToObs = o.xPos - tRex.xPos;
                        break;
                    }
                }
                if (tRex.jumping && tRex.ducking) {
                    tRex.setDuck(false);
                }

                var decisionZone = Math.max(DECISION_ZONE_BASE, speed * 10);
                if (distToObs < decisionZone || tRex.jumping) {
                    var state = agent.extractState(r);
                    var activations = forwardWithActivations(state, playNet);
                    var outputs = activations[activations.length - 1];
                    var bestAction = 0;
                    if (outputs[1] > outputs[bestAction]) bestAction = 1;
                    if (outputs[2] > outputs[bestAction]) bestAction = 2;
                    agent.executeAction(bestAction, r);

                    // Update NN viz every 6th frame (~10fps)
                    _nnVizFrame++;
                    if (_nnVizFrame % 6 === 0) {
                        updateNetworkSVG('nn-viz-svg', activations);
                    }
                } else {
                    if (tRex.ducking) tRex.setDuck(false);
                }
            },
            onCrash: function () {
                lastCrashScore = Math.round(runner.distanceRan * 0.025);
                if (lastCrashScore > _distillPlayerBest) _distillPlayerBest = lastCrashScore;
                _distillPlayerDeaths++;
                if (statusEl) statusEl.textContent = 'Teacher: Deaths: ' +
                    _distillPlayerDeaths + ' | Best: ' + _distillPlayerBest + ' | Last: ' + lastCrashScore;
            },
            recordPrediction: function () {},
            checkGhostCollisions: function () {}
        };

        runner.aiAgent = wrapper;
        runner.postRenderHook = null;
        runner.suppressCollision = false;

        if (runner.crashed) {
            runner.restart();
            runner.tRex.startJump(runner.currentSpeed);
        } else if (!runner.playing) {
            runner.loadSounds();
            runner.playing = true;
            runner.activated = true;
            runner.tRex.playingIntro = false;
            runner.playingIntro = false;
            runner.setArcadeMode();
            runner.containerEl.style.width = runner.dimensions.WIDTH + 'px';
            runner.tRex.startJump(runner.currentSpeed);
            runner.update();
        } else if (!runner.updatePending) {
            runner.update();
        }

        _distillPlayerTimer = setInterval(function () {
            if (!_distillPlayerRunning) {
                clearInterval(_distillPlayerTimer);
                return;
            }
            if (!runner.crashed && statusEl) {
                var score = Math.round(runner.distanceRan * 0.025);
                if (score > _distillPlayerBest) _distillPlayerBest = score;
                statusEl.textContent = 'Teacher: Score: ' + score +
                    ' | Deaths: ' + _distillPlayerDeaths + ' | Best: ' + _distillPlayerBest;
            }
        }, 200);
    };

    // ---------------------------------------------------------------
    // Play a snapshot network (from training) live in the game.
    // ---------------------------------------------------------------
    window.playSnapshotLive = function (snapshotIdx) {
        var agent = window.rlAgent;
        if (!agent) return;
        var snap;
        if (snapshotIdx === 'current') {
            var bestNet = agent.getBestNetwork();
            snap = { gen: agent.generation, fitness: agent.bestScore, net: bestNet };
        } else {
            snap = agent.getSnapshot(parseInt(snapshotIdx, 10));
        }
        if (!snap || !snap.net) return;

        // Build a network from the serialized snapshot.
        var net = createNetwork(LAYER_SIZES);
        deserializeNetwork(snap.net, net);

        var runner = window.evoRunner || Runner.instance_;
        if (!runner) return;

        // Stop other playback.
        if (_distillPlayerRunning) _stopDistillPlayer();

        _distillPlayerRunning = true;
        _distillPlayerDeaths = 0;
        _distillPlayerBest = 0;

        var statusEl = document.getElementById('teacher-stats');
        var genLabel = snap.gen !== undefined ? snap.gen : '?';
        if (statusEl) statusEl.textContent = 'Playing Gen ' + genLabel + ' (fitness ' + snap.fitness + ')...';

        var _nnVizFrame2 = 0;
        var wrapper = {
            enabled: true,
            update: function (r) {
                if (!_distillPlayerRunning || !r.playing) return;
                var tRex = r.tRex;
                var obstacles = r.horizon.obstacles;
                var speed = r.currentSpeed;

                var distToObs = 9999;
                for (var i = 0; i < obstacles.length; i++) {
                    var o = obstacles[i];
                    if (o.xPos + o.typeConfig.width * o.size > tRex.xPos) {
                        distToObs = o.xPos - tRex.xPos;
                        break;
                    }
                }
                if (tRex.jumping && tRex.ducking) tRex.setDuck(false);

                var decisionZone = Math.max(DECISION_ZONE_BASE, speed * 10);
                if (distToObs < decisionZone || tRex.jumping) {
                    var state = agent.extractState(r);
                    var activations = forwardWithActivations(state, net);
                    var outputs = activations[activations.length - 1];
                    var bestAction = 0;
                    if (outputs[1] > outputs[bestAction]) bestAction = 1;
                    if (outputs[2] > outputs[bestAction]) bestAction = 2;
                    agent.executeAction(bestAction, r);

                    _nnVizFrame2++;
                    if (_nnVizFrame2 % 6 === 0) {
                        updateNetworkSVG('nn-viz-svg', activations);
                    }
                } else {
                    if (tRex.ducking) tRex.setDuck(false);
                }
            },
            onCrash: function () {
                var score = Math.round(runner.distanceRan * 0.025);
                if (score > _distillPlayerBest) _distillPlayerBest = score;
                _distillPlayerDeaths++;
                if (statusEl) statusEl.textContent = 'Gen ' + genLabel + ': Deaths: ' +
                    _distillPlayerDeaths + ' | Best: ' + _distillPlayerBest + ' | Last: ' + score;
            },
            recordPrediction: function () {},
            checkGhostCollisions: function () {}
        };

        runner.aiAgent = wrapper;
        runner.postRenderHook = null;
        runner.suppressCollision = false;

        if (runner.crashed) {
            runner.restart();
            runner.tRex.startJump(runner.currentSpeed);
        } else if (!runner.playing) {
            runner.playing = true;
            runner.activated = true;
            runner.tRex.playingIntro = false;
            runner.playingIntro = false;
            runner.setArcadeMode();
            runner.containerEl.style.width = runner.dimensions.WIDTH + 'px';
            runner.tRex.startJump(runner.currentSpeed);
            runner.update();
        } else {
            // Runner is already playing (e.g. after stopping training).
            // Kick the animation loop since training may have neutered it.
            runner.scheduleNextUpdate();
        }

        _distillPlayerTimer = setInterval(function () {
            if (!_distillPlayerRunning) { clearInterval(_distillPlayerTimer); return; }
            if (!runner.crashed && statusEl) {
                var score = Math.round(runner.distanceRan * 0.025);
                if (score > _distillPlayerBest) _distillPlayerBest = score;
                statusEl.textContent = 'Gen ' + genLabel + ': Score: ' + score +
                    ' | Deaths: ' + _distillPlayerDeaths + ' | Best: ' + _distillPlayerBest;
            }
        }, 200);
    };

    // ---------------------------------------------------------------
    // Neural Network SVG Visualization
    // ---------------------------------------------------------------

    var NN_INPUT_LABELS = [
        'TTI', 'Ptero?', 'ObsY', 'Width',
        'TTI\u2082', 'Ptero\u2082?', 'ObsY\u2082',
        'Speed', 'JmpH', 'Jump?', 'Duck?', 'ObsH'
    ];
    var NN_OUTPUT_LABELS = ['RUN', 'JUMP', 'DUCK'];
    var NN_OUTPUT_COLORS = ['#888', '#4a9eff', '#e8a735'];

    /**
     * Build a static SVG diagram of the network.
     * Only draw top-N strongest edges to keep it readable.
     */
    function buildNetworkSVG(net, containerId) {
        var el = document.getElementById(containerId);
        if (!el || !net) return;

        var arch = net.sizes || LAYER_SIZES;
        var W = 520, H = Math.max(260, arch[1] * 14 + 20);
        var layerX = [60, W / 2, W - 60];
        var nodeR = 6;

        // Compute node positions
        var layers = [];
        for (var li = 0; li < arch.length; li++) {
            var n = arch[li];
            var positions = [];
            var totalH = (n - 1) * (li === 1 ? 12 : 20);
            var startY = (H - totalH) / 2;
            for (var ni = 0; ni < n; ni++) {
                positions.push({ x: layerX[li], y: startY + ni * (li === 1 ? 12 : 20) });
            }
            layers.push(positions);
        }

        var svg = '<svg class="nn-svg" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">';

        // Draw edges — select top N by magnitude for each layer
        for (var li = 0; li < net.layers.length; li++) {
            var L = net.layers[li];
            var fromPos = layers[li];
            var toPos = layers[li + 1];
            // Collect all edges with magnitudes
            var edges = [];
            for (var r = 0; r < L.rows; r++) {
                for (var c = 0; c < L.cols; c++) {
                    var w = L.W[r * L.cols + c];
                    edges.push({ from: c, to: r, w: w, mag: Math.abs(w) });
                }
            }
            // Sort by magnitude, take top N
            edges.sort(function (a, b) { return b.mag - a.mag; });
            var maxEdges = li === 0 ? 60 : 20;
            var topEdges = edges.slice(0, Math.min(maxEdges, edges.length));
            var maxMag = topEdges.length > 0 ? topEdges[0].mag : 1;

            for (var ei = 0; ei < topEdges.length; ei++) {
                var e = topEdges[ei];
                var opacity = (0.08 + 0.5 * (e.mag / maxMag)).toFixed(2);
                var color = e.w > 0 ? '#4a9eff' : '#e86464';
                var sw = (0.5 + 1.5 * (e.mag / maxMag)).toFixed(1);
                svg += '<line class="nn-edge" x1="' + (fromPos[e.from].x + nodeR) +
                    '" y1="' + fromPos[e.from].y +
                    '" x2="' + (toPos[e.to].x - nodeR) +
                    '" y2="' + toPos[e.to].y +
                    '" stroke="' + color + '" stroke-width="' + sw +
                    '" opacity="' + opacity + '"/>';
            }
        }

        // Draw nodes
        // Input layer
        for (var ni = 0; ni < layers[0].length; ni++) {
            var p = layers[0][ni];
            svg += '<circle class="nn-node nn-input" data-layer="0" data-idx="' + ni +
                '" cx="' + p.x + '" cy="' + p.y + '" r="' + nodeR + '"/>';
            svg += '<text class="nn-label nn-label-left" x="' + (p.x - nodeR - 4) +
                '" y="' + (p.y + 3.5) + '">' + NN_INPUT_LABELS[ni] + '</text>';
        }
        // Hidden layer
        for (var ni = 0; ni < layers[1].length; ni++) {
            var p = layers[1][ni];
            svg += '<circle class="nn-node nn-hidden" data-layer="1" data-idx="' + ni +
                '" cx="' + p.x + '" cy="' + p.y + '" r="' + (nodeR - 1) + '"/>';
        }
        // Output layer
        for (var ni = 0; ni < layers[2].length; ni++) {
            var p = layers[2][ni];
            svg += '<circle class="nn-node nn-output" data-layer="2" data-idx="' + ni +
                '" cx="' + p.x + '" cy="' + p.y + '" r="' + (nodeR + 2) + '"/>';
            svg += '<text class="nn-label nn-label-right" x="' + (p.x + nodeR + 6) +
                '" y="' + (p.y + 4) + '">' + NN_OUTPUT_LABELS[ni] + '</text>';
        }

        // Layer titles
        svg += '<text class="nn-layer-title" x="' + layerX[0] + '" y="14">Input (12)</text>';
        svg += '<text class="nn-layer-title" x="' + layerX[1] + '" y="14">Hidden (20)</text>';
        svg += '<text class="nn-layer-title" x="' + layerX[2] + '" y="14">Output (3)</text>';

        svg += '</svg>';
        el.innerHTML = svg;
    }

    /**
     * Update SVG node colors based on live activations.
     * activations: [input(12), hidden(20), output(3)]
     */
    function updateNetworkSVG(containerId, activations) {
        var el = document.getElementById(containerId);
        if (!el || !activations || activations.length < 3) return;

        // Compute softmax of outputs for probability display
        var out = activations[2];
        var maxOut = Math.max(out[0], out[1], out[2]);
        var expSum = 0;
        var probs = new Float64Array(3);
        for (var i = 0; i < 3; i++) {
            probs[i] = Math.exp(out[i] - maxOut);
            expSum += probs[i];
        }
        for (var i = 0; i < 3; i++) probs[i] /= expSum;

        var bestAction = 0;
        if (probs[1] > probs[bestAction]) bestAction = 1;
        if (probs[2] > probs[bestAction]) bestAction = 2;

        // Update input nodes
        var inputNodes = el.querySelectorAll('.nn-input');
        for (var i = 0; i < inputNodes.length; i++) {
            var val = activations[0][i] || 0;
            // Blue intensity based on value (0=light, 1=bright)
            var r = Math.round(220 - 150 * val);
            var g = Math.round(230 - 100 * val);
            var b = Math.round(245 - 10 * val);
            inputNodes[i].style.fill = 'rgb(' + r + ',' + g + ',' + b + ')';
            inputNodes[i].style.stroke = val > 0.3 ? '#4a9eff' : '#c7c7cc';
            inputNodes[i].style.strokeWidth = val > 0.5 ? '2' : '1';
        }

        // Update hidden nodes — find max activation for normalization
        var hidden = activations[1];
        var maxHidden = 0;
        for (var i = 0; i < hidden.length; i++) {
            if (hidden[i] > maxHidden) maxHidden = hidden[i];
        }
        if (maxHidden < 0.01) maxHidden = 1;

        var hiddenNodes = el.querySelectorAll('.nn-hidden');
        for (var i = 0; i < hiddenNodes.length; i++) {
            var val = hidden[i] / maxHidden;
            // Green intensity for ReLU activation
            var r = Math.round(235 - 165 * val);
            var g = Math.round(240 - 30 * val);
            var b = Math.round(235 - 165 * val);
            hiddenNodes[i].style.fill = val > 0.01 ? 'rgb(' + r + ',' + g + ',' + b + ')' : '#f0f0f5';
            hiddenNodes[i].style.stroke = val > 0.2 ? '#30d158' : '#d2d2d7';
        }

        // Update output nodes
        var outputNodes = el.querySelectorAll('.nn-output');
        for (var i = 0; i < outputNodes.length; i++) {
            var p = probs[i];
            var color = NN_OUTPUT_COLORS[i];
            if (i === bestAction) {
                outputNodes[i].style.fill = color;
                outputNodes[i].style.stroke = '#1d1d1f';
                outputNodes[i].style.strokeWidth = '2.5';
            } else {
                // Dim non-chosen actions
                outputNodes[i].style.fill = '#f0f0f5';
                outputNodes[i].style.stroke = '#d2d2d7';
                outputNodes[i].style.strokeWidth = '1';
            }
            // Show probability as opacity overlay
            outputNodes[i].style.opacity = (0.4 + 0.6 * p).toFixed(2);
        }
    }

    // Expose NN visualization functions globally
    window.buildNetworkSVG = function (net, containerId) { buildNetworkSVG(net, containerId); };
    window.updateNetworkSVG = function (containerId, activations) { updateNetworkSVG(containerId, activations); };
    window.forwardWithActivations = function (input, net) { return forwardWithActivations(input, net); };

    // ---------------------------------------------------------------
    // Shared utilities for other ML agents (Q-Learning, Decision Tree,
    // Logistic Regression).  extractState and executeAction only use
    // their `runner` parameter, so they work as standalone functions.
    // ---------------------------------------------------------------
    window.dinoShared = {
        extractState: RLAgent.prototype.extractState,
        executeAction: RLAgent.prototype.executeAction
    };

})();
