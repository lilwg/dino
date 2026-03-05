// =============================================================================
// AI Agent — Hand-crafted simulation-based AI for Chrome Dino game.
//
// Extracted from index.js so the game engine stays clean.
// Depends on: Runner, Trex, CollisionBox, boxCompare, createAdjustedCollisionBox
// (all exposed on window by index.js).
// =============================================================================
(function () {
    'use strict';

    // Grab references from the game engine (exposed on window by index.js).
    var Trex = window.Trex;
    var CollisionBox = window.CollisionBox;
    var boxCompare = window.boxCompare;
    var createAdjustedCollisionBox = window.createAdjustedCollisionBox;

    //******************************************************************************
    /**
     * AI Agent — Uses the game's own code to simulate outcomes.
     *
     * Instead of reimplementing physics, we clone the relevant game state
     * and run the actual updateJump / obstacle movement / collision detection
     * code forward in time. This guarantees zero simulation-vs-reality drift.
     *
     * Decision logic is pure simulation:
     *  1. Each frame, simulate "run", "jump", and "duck" forward N steps.
     *  2. If running is safe → keep running (handles timing automatically).
     *  3. If running will collide → pick the safe action (jump or duck).
     *  4. Mid-jump: check if speed-drop helps or is safe proactively.
     *
     * @constructor
     */
    function AIAgent() {
        this.enabled = false;
        this.deaths = 0;
        this.bestScore = 0;
        this._vizEnabled = false;
        this._vizData = null;
        this.loadStats();
    }

    AIAgent.prototype = {
        GROUND_Y: Runner.defaultDimensions.HEIGHT - Trex.config.HEIGHT -
            Runner.config.BOTTOM_PAD,

        /**
         * Clone the minimal tRex state needed for jump simulation.
         */
        cloneTrex: function (tRex) {
            return {
                xPos: tRex.xPos,
                yPos: tRex.yPos,
                jumping: tRex.jumping,
                ducking: tRex.ducking,
                jumpVelocity: tRex.jumpVelocity,
                reachedMinHeight: tRex.reachedMinHeight,
                speedDrop: tRex.speedDrop,
                groundYPos: tRex.groundYPos,
                minJumpHeight: tRex.minJumpHeight,
                config: tRex.config
            };
        },

        /**
         * Step the tRex clone forward one frame using the game's exact
         * updateJump physics. deltaTime = 1000/60 for a perfect 60fps frame.
         * @param {Object} sim Cloned tRex state.
         * @param {number} speed Current game speed.
         */
        stepTrex: function (sim) {
            if (!sim.jumping) return;

            // Exact copy of Trex.updateJump logic.
            // msPerFrame for JUMPING status = 1000/60.
            var msPerFrame = 1000 / 60;
            var deltaTime = 1000 / 60; // simulate at perfect 60fps
            var framesElapsed = deltaTime / msPerFrame; // = 1.0

            if (sim.speedDrop) {
                sim.yPos += Math.round(sim.jumpVelocity *
                    sim.config.SPEED_DROP_COEFFICIENT * framesElapsed);
            } else {
                sim.yPos += Math.round(sim.jumpVelocity * framesElapsed);
            }

            sim.jumpVelocity += sim.config.GRAVITY * framesElapsed;

            // Minimum height check.
            if (sim.yPos < sim.minJumpHeight || sim.speedDrop) {
                sim.reachedMinHeight = true;
            }

            // Max height / endJump.
            if (sim.yPos < sim.config.MAX_JUMP_HEIGHT || sim.speedDrop) {
                // endJump: cap velocity
                if (sim.reachedMinHeight &&
                    sim.jumpVelocity < sim.config.DROP_VELOCITY) {
                    sim.jumpVelocity = sim.config.DROP_VELOCITY;
                }
            }

            // Landed.  Use >= so exact-groundYPos landings are caught.
            if (sim.yPos >= sim.groundYPos) {
                sim.yPos = sim.groundYPos;
                sim.jumping = false;
                sim.ducking = false;
                sim.speedDrop = false;
                sim.jumpVelocity = 0;
            }
        },

        /**
         * Start a jump on a tRex clone. Exact copy of Trex.startJump.
         * @param {Object} sim Cloned tRex state.
         * @param {number} speed Current game speed.
         */
        startJump: function (sim, speed) {
            if (!sim.jumping) {
                sim.jumping = true;
                sim.reachedMinHeight = false;
                sim.speedDrop = false;
                sim.jumpVelocity = sim.config.INIITAL_JUMP_VELOCITY - (speed / 10);
            }
        },

        /**
         * Activate speed-drop on a tRex clone. Exact copy of Trex.setSpeedDrop.
         * @param {Object} sim Cloned tRex state.
         */
        setSpeedDrop: function (sim) {
            sim.speedDrop = true;
            sim.jumpVelocity = 1;
        },

        /**
         * Simulate a full jump from ground and return the arc (Y positions).
         * Used to compute jump duration for the lookahead window.
         * @param {number} speed Current game speed.
         * @return {Array<number>} Y positions per frame.
         */
        simulateJump: function (speed, runner) {
            var tRex = runner.tRex;
            var sim = this.cloneTrex(tRex);
            sim.yPos = sim.groundYPos;
            sim.jumping = false;
            sim.ducking = false;
            sim.speedDrop = false;
            sim.jumpVelocity = 0;
            this.startJump(sim, speed);
            var frames = [];
            for (var f = 0; f < 80; f++) {
                this.stepTrex(sim);
                frames.push(sim.yPos);
                if (!sim.jumping) break;
            }
            return frames;
        },

        /**
         * Compute obstacle X position after N frames.
         * Uses the game's exact formula: xPos -= Math.floor((speed * FPS / 1000) * deltaTime)
         * At 60fps: Math.floor(speed * 60/1000 * 16.667) = Math.floor(speed * 1.0)
         * @param {Object} obs The obstacle.
         * @param {number} speed Game speed.
         * @param {number} nFrames Number of frames forward.
         * @return {number} Future X position.
         */
        futureObstX: function (obs, speed, nFrames) {
            var obstSpeed = speed;
            if (obs.typeConfig.speedOffset) {
                obstSpeed += (obs.speedOffset || 0);
            }

            var accel = this._accel || 0;
            var maxSpd = this._maxSpeed || 999;

            if (accel > 0 && nFrames > 1) {
                // With acceleration, each future frame the game speed is
                // higher, so obstacles approach progressively faster than
                // the current speed alone predicts.  Sum frame-by-frame.
                var total = 0;
                for (var i = 0; i < nFrames; i++) {
                    total += Math.floor(Math.min(obstSpeed + i * accel, maxSpd));
                }
                return obs.xPos - total;
            }

            var perFrame = Math.floor(obstSpeed);
            return obs.xPos - perFrame * nFrames;
        },

        /**
         * Compute the minimum vertical/horizontal gap between sim tRex
         * and an obstacle at a given frame. Returns positive if no overlap
         * (clearance), negative if overlapping (penetration depth).
         */
        _gapToObstacle: function (sim, obs, obstX) {
            // Use the detailed inner collision boxes for accuracy.
            var tRexOuter = new CollisionBox(
                sim.xPos + 1, sim.yPos + 1,
                sim.config.WIDTH - 2, sim.config.HEIGHT - 2);
            var obstOuter = new CollisionBox(
                obstX + 1, obs.yPos + 1,
                obs.typeConfig.width * obs.size - 2,
                obs.typeConfig.height - 2);

            // First check if outer boxes are even close.
            // Horizontal gap between outer boxes:
            var hGapOuter = Math.max(obstOuter.x - (tRexOuter.x + tRexOuter.width),
                                     tRexOuter.x - (obstOuter.x + obstOuter.width));
            if (hGapOuter > 50) return 9999; // way too far, skip detail

            // Get inner boxes based on ducking state.
            var tRexBoxes = sim.ducking ?
                Trex.collisionBoxes.DUCKING : Trex.collisionBoxes.RUNNING;
            var obstBoxes = obs.collisionBoxes;

            var minGap = 9999;
            for (var t = 0; t < tRexBoxes.length; t++) {
                for (var o = 0; o < obstBoxes.length; o++) {
                    var adjT = createAdjustedCollisionBox(tRexBoxes[t], tRexOuter);
                    var adjO = createAdjustedCollisionBox(obstBoxes[o], obstOuter);

                    // Compute gap on each axis. Positive = separated, negative = overlapping.
                    var hGap = Math.max(adjO.x - (adjT.x + adjT.width),
                                        adjT.x - (adjO.x + adjO.width));
                    var vGap = Math.max(adjO.y - (adjT.y + adjT.height),
                                        adjT.y - (adjO.y + adjO.height));

                    // If separated on either axis, gap is the max of the two
                    // (you need overlap on BOTH axes for collision).
                    // If overlapping on both, gap is negative (the less-negative axis).
                    var gap;
                    if (hGap > 0 || vGap > 0) {
                        gap = Math.max(hGap, vGap); // separated
                    } else {
                        gap = Math.max(hGap, vGap); // both negative, least penetration
                    }

                    if (gap < minGap) minGap = gap;
                }
            }
            return minGap;
        },

        /**
         * Simulate an action forward N frames and return:
         *   { collisionFrame: number, minClearance: number }
         *
         * collisionFrame: frame of first collision, or -1 if none.
         * minClearance: smallest gap (in pixels) between tRex and any obstacle
         *   across the entire simulation. Positive = safe buffer. Negative = collision.
         *   Higher is safer — the AI should prefer actions with larger minClearance.
         *
         * @param {string} action 'run', 'jump', 'duck', or 'speedDrop'.
         * @param {Object} tRex The real T-Rex object.
         * @param {Array} obstacles Obstacles ahead.
         * @param {number} speed Current game speed.
         * @param {number} numFrames Frames to simulate.
         * @return {Object} { collisionFrame, minClearance }
         */
        simulate: function (action, tRex, obstacles, speed, numFrames, captureFrames) {
            var sim = this.cloneTrex(tRex);

            if (action === 'jump' && !sim.jumping) {
                this.startJump(sim, speed);
            } else if (action === 'speedDrop' && sim.jumping) {
                this.setSpeedDrop(sim);
            } else if (action === 'duck') {
                sim.ducking = true;
                sim.jumping = false;
            } else if (action === 'run') {
                sim.ducking = false;
            }

            // Optional: capture frame-by-frame positions for visualization.
            var framePositions = captureFrames ? [] : null;

            // Track state transitions so we can chain follow-up actions.
            var inAir = sim.jumping;
            var transitioned = false;
            var postAction = null;

            // For duck chaining: track the first obstacle to detect when it passes.
            var isDuckAction = (action === 'duck');
            var firstObstPassed = false;
            var firstObstIdx = -1;
            if (isDuckAction && obstacles.length > 0) {
                for (var i = 0; i < obstacles.length; i++) {
                    var ox0 = this.futureObstX(obstacles[i], speed, 0);
                    if (ox0 + obstacles[i].typeConfig.width * obstacles[i].size >= sim.xPos) {
                        firstObstIdx = i;
                        break;
                    }
                }
            }

            var overallMinClearance = 9999;

            for (var f = 0; f < numFrames; f++) {
                this.stepTrex(sim);

                // Transition 1: Detect landing from jump/speedDrop.
                if (!sim.jumping && !transitioned && inAir) {
                    transitioned = true;
                    postAction = this._pickPostLandingAction(
                        sim, obstacles, speed, f + 1, numFrames - f - 1);
                }

                // Transition 2: Detect first obstacle passing during duck.
                if (isDuckAction && !transitioned && !firstObstPassed &&
                    firstObstIdx >= 0) {
                    var firstObs = obstacles[firstObstIdx];
                    var fox = this.futureObstX(firstObs, speed, f + 1);
                    if (fox + firstObs.typeConfig.width * firstObs.size < sim.xPos) {
                        firstObstPassed = true;
                        transitioned = true;
                        postAction = this._pickPostLandingAction(
                            sim, obstacles, speed, f + 1, numFrames - f - 1);
                    }
                }

                // Apply state based on transitions.
                if (!sim.jumping) {
                    if (transitioned && postAction === 'jump') {
                        this.startJump(sim, speed);
                        postAction = 'jumped';
                    } else if (transitioned && postAction === 'duck') {
                        sim.ducking = true;
                    } else if (transitioned) {
                        sim.ducking = false;
                    } else if (action === 'duck' || action === 'speedDrop') {
                        sim.ducking = true;
                    } else {
                        sim.ducking = false;
                    }
                }

                // Measure clearance to each obstacle.
                var frameClearance = 9999;
                var frameCollided = false;
                for (var i = 0; i < obstacles.length; i++) {
                    var obs = obstacles[i];
                    var ox = this.futureObstX(obs, speed, f + 1);

                    if (ox + obs.typeConfig.width * obs.size < sim.xPos) continue;
                    if (ox > sim.xPos + 600) continue;

                    var gap = this._gapToObstacle(sim, obs, ox);

                    if (gap < overallMinClearance) {
                        overallMinClearance = gap;
                    }
                    if (gap < frameClearance) {
                        frameClearance = gap;
                    }

                    // If gap is actually negative (true overlap, not just
                    // drift-adjusted), that's a collision.
                    if (gap <= 0) {
                        frameCollided = true;
                        if (framePositions) {
                            framePositions.push({
                                x: sim.xPos, y: sim.yPos,
                                ducking: sim.ducking, jumping: sim.jumping,
                                clearance: -1
                            });
                        }
                        return { collisionFrame: f, minClearance: overallMinClearance,
                                 framePositions: framePositions };
                    }
                }

                // Capture position + per-frame clearance for visualization.
                if (framePositions) {
                    framePositions.push({
                        x: sim.xPos,
                        y: sim.yPos,
                        ducking: sim.ducking,
                        jumping: sim.jumping,
                        clearance: frameClearance
                    });
                }
            }
            return { collisionFrame: -1, minClearance: overallMinClearance,
                     framePositions: framePositions };
        },

        /**
         * After a jump lands, pick the best follow-up action.
         * Runs a quick sub-simulation to see if running, jumping, or ducking
         * survives. Returns 'run', 'jump', or 'duck'.
         */
        _pickPostLandingAction: function (sim, obstacles, speed, currentFrame, remainingFrames) {
            // Use only the remaining frames from the parent simulation
            // window — do NOT extend. The parent sim uses 2×jumpDur, so
            // extending here gives compound sequences an unfair extra
            // lookahead that makes premature jumping appear safe.
            if (remainingFrames <= 0) return 'run';

            // Evaluate each action's minimum clearance using a sub-simulation.
            var actions = ['run', 'jump', 'duck'];
            var bestAction = 'run';
            var bestClearance = -9999;

            for (var a = 0; a < actions.length; a++) {
                var act = actions[a];
                var sub = this.cloneTrex(sim);
                var minClear = 9999;
                var collided = false;

                if (act === 'jump') this.startJump(sub, speed);
                else if (act === 'duck') sub.ducking = true;
                else sub.ducking = false;

                for (var f = 0; f < remainingFrames; f++) {
                    if (act === 'jump') this.stepTrex(sub);
                    if (act === 'jump' && !sub.jumping) sub.ducking = false;

                    for (var i = 0; i < obstacles.length; i++) {
                        var obs = obstacles[i];
                        var fOffset = (act === 'jump') ? f + 1 : f;
                        var ox = this.futureObstX(obs, speed, currentFrame + fOffset);
                        if (ox + obs.typeConfig.width * obs.size < sub.xPos) continue;
                        if (ox > sub.xPos + 600) continue;

                        var gap = this._gapToObstacle(sub, obs, ox);
                        if (gap < minClear) minClear = gap;

                        if (gap <= 0) { collided = true; break; }
                    }
                    if (collided) break;
                }

                if (minClear > bestClearance) {
                    bestClearance = minClear;
                    bestAction = act;
                }
            }
            return bestAction;
        },

        onCrash: function (runner) {
            this.deaths++;
            var score = Math.round(runner.distanceRan * 0.025);
            if (score > this.bestScore) this.bestScore = score;

            // Detailed crash log for debugging.
            var tRex = runner.tRex;
            var obstacles = runner.horizon.obstacles;
            var info = 'CRASH #' + this.deaths + ' score=' + score +
                ' spd=' + runner.currentSpeed.toFixed(1) +
                ' tX=' + tRex.xPos + ' tY=' + tRex.yPos +
                ' j=' + tRex.jumping + ' dk=' + tRex.ducking +
                ' dr=' + tRex.speedDrop;
            // Log ALL obstacles so we can see what the dino actually hit.
            for (var i = 0; i < obstacles.length; i++) {
                var o = obstacles[i];
                info += ' | [' + i + '] ' + o.typeConfig.type +
                    ' x=' + o.xPos + ' y=' + o.yPos +
                    ' sz=' + o.size;
            }
            console.log(info);

            // Dump prediction vs actual comparison history.
            if (this._history && this._history.length > 0) {
                console.log('--- PREDICTION vs ACTUAL (last ' + this._history.length + ' frames) ---');
                for (var h = 0; h < this._history.length; h++) {
                    var entry = this._history[h];
                    var pr = entry.predicted;
                    var ac = entry.actual;
                    console.log('  [' + h + '] dt=' + entry.dt.toFixed(1) +
                        ' pred tY=' + pr.tY.toFixed(0) +
                        ' j=' + pr.tJ + ' dk=' + pr.tDk +
                        ' obstX=' + (pr.obstX !== null ? pr.obstX.toFixed(0) : 'n/a') +
                        ' | actual tY=' + ac.tY.toFixed(0) +
                        ' j=' + ac.tJ + ' dk=' + ac.tDk +
                        ' obstX=' + (ac.obstX !== null ? ac.obstX.toFixed(0) : 'n/a') +
                        ' | ΔY=' + entry.deltaY.toFixed(0) +
                        ' ΔX=' + entry.deltaX.toFixed(0));
                }
            }
            this._history = [];

            this.saveStats();
            this.updateStats();
        },

        saveStats: function () {
            try {
                localStorage.setItem('dinoAI_deaths', String(this.deaths));
                localStorage.setItem('dinoAI_bestScore', String(this.bestScore));
            } catch (e) {}
        },

        loadStats: function () {
            try {
                var d = localStorage.getItem('dinoAI_deaths');
                if (d) this.deaths = parseInt(d, 10) || 0;
                var b = localStorage.getItem('dinoAI_bestScore');
                if (b) this.bestScore = parseInt(b, 10) || 0;
            } catch (e) {}
        },

        updateStats: function () {
            var el = document.getElementById('ai-stats');
            if (el) {
                el.textContent = 'Deaths: ' + this.deaths +
                    ' | Best: ' + this.bestScore;
            }
        },

        /**
         * Main AI decision loop — pure simulation.
         * @param {Runner} runner The game runner instance.
         */
        update: function (runner) {
            if (!this.enabled || !runner.playing || runner.crashed) return;

            var tRex = runner.tRex;
            var obstacles = runner.horizon.obstacles;
            var speed = runner.currentSpeed;

            // --- PREDICTION COMPARISON ---
            // Compare last frame's prediction to current actual state.
            if (this._prediction) {
                var p = this._prediction;
                var actual = {
                    tY: tRex.yPos,
                    tJ: tRex.jumping,
                    tDk: tRex.ducking,
                    obstX: obstacles.length > 0 ? obstacles[0].xPos : null
                };
                var dY = Math.abs(p.tY - actual.tY);
                var dX = p.obstX !== null && actual.obstX !== null ?
                    Math.abs(p.obstX - actual.obstX) : 0;
                if (!this._history) this._history = [];
                this._history.push({
                    predicted: p,
                    actual: actual,
                    deltaY: dY,
                    deltaX: dX,
                    dt: this._lastDeltaTime || 0
                });
                if (this._history.length > 15) this._history.shift();
            }

            // Fix stuck ducking state: if the dino is jumping AND
            // ducking (from a speed-drop landing), un-duck immediately.
            if (tRex.jumping && tRex.ducking) tRex.setDuck(false);

            // Gather obstacles ahead of the dino.
            var ahead = [];
            for (var i = 0; i < obstacles.length; i++) {
                var o = obstacles[i];
                if (o.xPos + o.typeConfig.width * o.size > tRex.xPos) {
                    ahead.push(o);
                }
            }

            if (ahead.length === 0) {
                if (tRex.ducking) tRex.setDuck(false);
                // Still produce viz data so trails are always visible.
                if (this._vizEnabled && !tRex.jumping) {
                    var emptyAhead = [];
                    var vizN = (this._jumpDuration || 30) * 2;
                    var jR = this.simulate('jump', tRex, emptyAhead, speed, vizN, true);
                    var dR = this.simulate('duck', tRex, emptyAhead, speed, vizN, true);
                    var rR = this.simulate('run',  tRex, emptyAhead, speed, vizN, true);
                    this._vizData = {
                        jumpArc: jR.framePositions,
                        duckPositions: dR.framePositions,
                        runPositions: rR.framePositions,
                        clearances: {
                            jump: { minClearance: 9999, collisionFrame: -1 },
                            duck: { minClearance: 9999, collisionFrame: -1 },
                            run:  { minClearance: 9999, collisionFrame: -1 }
                        },
                        chosenAction: 'run',
                        deciding: false,
                        obstacles: [],
                        tRexPos: { x: tRex.xPos, y: tRex.yPos,
                                   jumping: tRex.jumping, ducking: tRex.ducking },
                        speed: speed
                    };
                } else if (!tRex.jumping) {
                    this._vizData = null;
                }
                return;
            }

            // Store acceleration info for futureObstX to account for
            // obstacles approaching faster as speed increases.
            this._accel = runner.config.ACCELERATION || 0;
            this._maxSpeed = runner.config.MAX_SPEED || 13;
            if (speed >= this._maxSpeed) this._accel = 0;

            // Compute jump duration (frames) at current speed.
            if (!this._jumpDuration || this._jumpDurationSpeed !== Math.floor(speed)) {
                var arc = this.simulateJump(speed, runner);
                this._jumpDuration = arc.length;
                this._jumpDurationSpeed = Math.floor(speed);
            }

            // Simulation window: 2x jump duration covers the current
            // obstacle plus the next one. This lets the AI "see" whether
            // landing from a jump leaves enough time for the next action.
            var N = this._jumpDuration * 2;

            // --- MID-JUMP ---
            if (tRex.jumping) {
                if (tRex.speedDrop) return;

                var viz = this._vizEnabled;

                // Only consider speed-dropping to avoid collisions during
                // the current jump. After landing, ground logic takes over.
                // Use the full N window so drop simulation can check
                // post-landing safety too.
                var continueR = this.simulate('run', tRex, ahead, speed, N, viz);
                var dropR = this.simulate('speedDrop', tRex, ahead, speed, N, viz);

                // Speed-drop if continuing has low clearance but dropping is better.
                // Use clearance comparison: drop if it gives significantly more buffer.
                // Speed-drop if continuing would collide but dropping avoids it,
                // or if dropping gives notably more clearance.
                var contHits = continueR.collisionFrame >= 0;
                var dropHits = dropR.collisionFrame >= 0;

                var didDrop = false;
                if (contHits && !dropHits) {
                    // Continue hits but drop avoids → check if deferring
                    // the drop by 1 frame gives even better clearance.
                    // Same principle as the ground jump-timing logic:
                    // each frame, if waiting is safer, wait.
                    // Offset obstacle positions by 1 frame of movement
                    // so the delayed sim sees the correct distances.
                    var dropPerFrame = Math.floor(speed);
                    var delayDropAhead = [];
                    for (var dd = 0; dd < ahead.length; dd++) {
                        var ddCopy = Object.create(ahead[dd]);
                        ddCopy.xPos = ahead[dd].xPos - dropPerFrame;
                        delayDropAhead.push(ddCopy);
                    }
                    var delayedDrop = this.simulate('speedDrop', tRex, delayDropAhead, speed, N - 1, false);
                    if (delayedDrop.collisionFrame < 0 && delayedDrop.minClearance > dropR.minClearance) {
                        // Delayed drop is safe AND has better clearance — defer.
                        // Don't drop this frame; re-evaluate next frame.
                    } else {
                        tRex.setSpeedDrop();
                        didDrop = true;
                    }
                }
                // Don't speed-drop when both options collide — staying
                // in the arc gives more airtime to clear the obstacle.

                // Store mid-jump viz: jump arc = continue, duck = speed drop.
                if (viz) {
                    this._vizData = {
                        jumpArc: continueR.framePositions,
                        duckPositions: dropR.framePositions,
                        runPositions: [],
                        clearances: {
                            run:  { minClearance: 9999, collisionFrame: -1 },
                            jump: { minClearance: continueR.minClearance, collisionFrame: continueR.collisionFrame },
                            duck: { minClearance: dropR.minClearance, collisionFrame: dropR.collisionFrame }
                        },
                        chosenAction: didDrop ? 'duck' : 'jump',
                        deciding: true,
                        midJump: true,
                        obstacles: ahead.map(function (o) {
                            return {
                                xPos: o.xPos, yPos: o.yPos,
                                width: o.typeConfig.width * o.size,
                                height: o.typeConfig.height,
                                type: o.typeConfig.type
                            };
                        }),
                        tRexPos: {
                            x: tRex.xPos, y: tRex.yPos,
                            jumping: tRex.jumping, ducking: tRex.ducking
                        },
                        speed: speed
                    };
                }
                return;
            }

            // --- ON GROUND ---
            // Simulate all three actions for the same N-frame window.
            // Each simulation chains into the best follow-up after
            // transitions (landing from jump, obstacle passing during duck).
            // Then pick the safest: if running is safe, run.
            var jumpDur = this._jumpDuration;
            var viz = this._vizEnabled;
            var runR = this.simulate('run', tRex, ahead, speed, N, viz);
            var jumpR = this.simulate('jump', tRex, ahead, speed, N, viz);
            var duckR = this.simulate('duck', tRex, ahead, speed, N, viz);

            // Helper: store visualization data for any chosen action.
            var self = this;
            function storeViz(chosenAction, deciding) {
                if (!self._vizEnabled) return;
                self._vizData = {
                    jumpArc: jumpR.framePositions,
                    duckPositions: duckR.framePositions,
                    runPositions: runR.framePositions,
                    clearances: {
                        run:  { minClearance: runR.minClearance,  collisionFrame: runR.collisionFrame },
                        jump: { minClearance: jumpR.minClearance, collisionFrame: jumpR.collisionFrame },
                        duck: { minClearance: duckR.minClearance, collisionFrame: duckR.collisionFrame }
                    },
                    chosenAction: chosenAction,
                    deciding: deciding !== false,
                    obstacles: ahead.map(function (o) {
                        return {
                            xPos: o.xPos, yPos: o.yPos,
                            width: o.typeConfig.width * o.size,
                            height: o.typeConfig.height,
                            type: o.typeConfig.type
                        };
                    }),
                    tRexPos: {
                        x: tRex.xPos, y: tRex.yPos,
                        jumping: tRex.jumping, ducking: tRex.ducking
                    },
                    speed: speed
                };
            }

            // Pure simulation decision — no arbitrary thresholds.
            // Compare all three actions and pick the safest.
            // "Safe" = no collision. Among safe actions, prefer running
            // (do nothing). Among unsafe actions, pick highest clearance.
            var nearest = ahead[0];
            var isPtero = nearest.typeConfig.type === 'PTERODACTYL';

            // For ground obstacles, ducking is useless (wider hitbox).
            // Only include duck in the sort for pterodactyls.
            var actions = [
                { action: 'run',  cf: runR.collisionFrame,  cl: runR.minClearance },
                { action: 'jump', cf: jumpR.collisionFrame, cl: jumpR.minClearance }
            ];
            if (isPtero) {
                actions.push({ action: 'duck', cf: duckR.collisionFrame, cl: duckR.minClearance });
            }

            // Sort: safe actions first (cf < 0), then by clearance desc.
            // Among safe actions, prefer run > duck > jump (least action).
            actions.sort(function (a, b) {
                var aSafe = a.cf < 0 ? 1 : 0;
                var bSafe = b.cf < 0 ? 1 : 0;
                if (aSafe !== bSafe) return bSafe - aSafe;
                if (aSafe && bSafe) {
                    // Both safe — prefer running (inaction), then duck.
                    var order = { run: 0, duck: 1, jump: 2 };
                    return order[a.action] - order[b.action];
                }
                // Both unsafe — prefer highest clearance (least bad).
                return b.cl - a.cl;
            });

            var best = actions[0];

            // Jump-range guard: only evade when the obstacle is within
            // one jump duration. Beyond that, the jump arc can't
            // physically overlap with the obstacle — any "safe" result
            // from the jump sim comes from compound chaining (jump →
            // land → jump again), not the arc itself. Keep running and
            // reassess each frame as the obstacle approaches.
            if (best.action !== 'run' && runR.collisionFrame >= 0 &&
                runR.collisionFrame >= jumpDur) {
                best = { action: 'run', cf: runR.collisionFrame, cl: runR.minClearance };
            }

            // Safe-jump guard: never commit to a jump that the sim
            // says will collide during the first arc. If the collision
            // is within jumpDur frames, the arc itself can't clear the
            // obstacle — keep running so the AI can re-evaluate next
            // frame when the obstacle is closer (and the arc timing
            // might work out).
            if (best.action === 'jump' && jumpR.collisionFrame >= 0 &&
                jumpR.collisionFrame < jumpDur) {
                best = { action: 'run', cf: runR.collisionFrame, cl: runR.minClearance };
            }

            // Optimal jump timing: if jump is selected, check whether
            // waiting one more frame (run now, jump next frame) gives
            // better clearance. If so, defer — the AI re-evaluates
            // every frame, so it will naturally find the peak-clearance
            // timing where the obstacle meets the top of the arc.
            //
            // Key: we must offset obstacle positions by 1 frame of
            // movement to accurately simulate "wait 1 frame, then jump."
            // Without this, the delayed sim sees obstacles at the same
            // distance as "jump now" and clearances appear equal.
            if (best.action === 'jump' && runR.collisionFrame >= 0) {
                var perFrame = Math.floor(speed);
                var delayAhead = [];
                for (var da = 0; da < ahead.length; da++) {
                    var copy = Object.create(ahead[da]);
                    copy.xPos = ahead[da].xPos - perFrame;
                    delayAhead.push(copy);
                }
                var delayedJump = this.simulate('jump', tRex, delayAhead, speed, N - 1, false);
                if (delayedJump.collisionFrame < 0 && delayedJump.minClearance > jumpR.minClearance) {
                    best = { action: 'run', cf: runR.collisionFrame, cl: runR.minClearance };
                }
            }

            // For low pterodactyls, prefer duck if it avoids collision.
            if (isPtero && nearest.yPos <= 75 && duckR.collisionFrame < 0) {
                best = { action: 'duck', cf: duckR.collisionFrame, cl: duckR.minClearance };
            }

            // Execute.
            if (best.action === 'run') {
                if (tRex.ducking) tRex.setDuck(false);
                storeViz('run');
            } else if (best.action === 'jump') {
                if (tRex.ducking) tRex.setDuck(false);
                tRex.startJump(speed);
                storeViz('jump');
            } else if (best.action === 'duck') {
                if (!tRex.ducking) tRex.setDuck(true);
                storeViz('duck');
            }
        },

        /**
         * Record prediction for next frame. Called after AI decision.
         */
        recordPrediction: function (tRex, obstacles, speed) {
            // Predict where tRex and obstacles will be after 1 game frame.
            var sim = this.cloneTrex(tRex);
            this.stepTrex(sim);
            var obstX = null;
            if (obstacles.length > 0) {
                obstX = this.futureObstX(obstacles[0], speed, 1);
            }
            this._prediction = {
                tY: sim.yPos,
                tJ: sim.jumping,
                tDk: sim.ducking,
                obstX: obstX
            };
        }
    };

    // Singleton AI agent instance.
    var aiAgent = new AIAgent();

    // Expose toggle function globally.
    window.toggleAI = function () {
        var runner = Runner.instance_;
        aiAgent.enabled = !aiAgent.enabled;
        var btn = document.getElementById('ai-toggle');
        btn.textContent = aiAgent.enabled ? 'AI: ON' : 'AI: OFF';
        btn.classList.toggle('active', aiAgent.enabled);

        // Hide/show the "Press Space to start" message.
        var msgBox = document.getElementById('messageBox');
        if (msgBox) {
            msgBox.style.display = aiAgent.enabled ? 'none' : '';
        }

        // If AI is enabled and game hasn't started, start it.
        if (aiAgent.enabled && runner) {
            if (runner.crashed) {
                runner.restart();
            } else if (!runner.playing) {
                runner.loadSounds();
                runner.playing = true;
                runner.activated = true;
                // Skip the intro animation — go straight to gameplay.
                runner.tRex.playingIntro = false;
                runner.playingIntro = false;
                if (window._arcadeEnabled) {
                    runner.setArcadeMode();
                }
                runner.containerEl.style.width = runner.dimensions.WIDTH + 'px';
                runner.tRex.startJump(runner.currentSpeed);
                runner.update();
            }
        }

        aiAgent.updateStats();
    };

    // Expose the sim agent for app.html to wire up per-section.
    window._simAgent = aiAgent;

    // Arcade mode toggle.
    window._arcadeEnabled = true; // default: on
    window.toggleArcade = function () {
        var runner = Runner.instance_;
        var btn = document.getElementById('arcade-toggle');
        window._arcadeEnabled = !window._arcadeEnabled;
        if (window._arcadeEnabled) {
            btn.textContent = 'ARCADE: ON';
            btn.classList.remove('inactive');
            if (runner) {
                runner.setArcadeMode();
            }
        } else {
            btn.textContent = 'ARCADE: OFF';
            btn.classList.add('inactive');
            if (runner) {
                runner.outerContainerEl.classList.remove(Runner.classes.ARCADE_MODE);
                runner.containerEl.style.transform = '';
            }
        }
    };

    // Expose AIAgent constructor for use by decision-tree.js, logistic-agent.js
    window.AIAgent = AIAgent;
})();
