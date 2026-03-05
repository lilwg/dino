// =============================================================================
// Q-Learning Agent — Tabular RL for Chrome Dino game.
//
// Discretizes the 12-feature state vector into 192 bins using 5 informative
// features, then learns a Q-table via Bellman updates + experience replay.
// No model — just a lookup table that improves through experience.
//
// Depends on: window.dinoShared (extractState, executeAction) from rl-agent.js
// =============================================================================
(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Hyperparameters
    // -----------------------------------------------------------------------
    var ALPHA           = 0.1;     // learning rate
    var GAMMA           = 0.95;    // discount factor
    var EPSILON_START   = 1.0;     // initial exploration rate
    var EPSILON_MIN     = 0.05;    // minimum exploration
    var EPSILON_DECAY   = 0.999;   // per-frame decay (faster than before)
    var DEATH_PENALTY   = -100;    // reward on crash
    var ALIVE_REWARD    = 1;       // reward per frame survived

    // -----------------------------------------------------------------------
    // State discretization
    //
    // 5 features from the 12-feature vector, 192 total discrete states:
    //   time-to-impact  [0] → 8 bins  (speed-normalized, most actionable)
    //   is_pterodactyl  [1] → 2 bins  (determines jump vs duck)
    //   is_jumping      [9] → 2 bins  (constrains available actions)
    //   obstacle_height [2] → 3 bins  (ptero height: high/mid/low)
    //   2nd_obs_close   [4] → 2 bins  (planning for obstacle pairs)
    //
    // Speed bins removed: TTI already normalizes for speed (dist/speed/30).
    // -----------------------------------------------------------------------
    var TTI_BINS   = 8;
    var PTERO_BINS = 2;
    var JUMP_BINS  = 2;
    var OBS_Y_BINS = 3;  // high ptero (run under) / mid / low (duck)
    var OBS2_BINS  = 2;  // 2nd obstacle close? yes/no
    var NUM_STATES = TTI_BINS * PTERO_BINS * JUMP_BINS * OBS_Y_BINS * OBS2_BINS; // 192
    var NUM_ACTIONS = 3; // run, jump, duck

    // Experience replay
    var REPLAY_SIZE      = 500;  // ring buffer capacity
    var REPLAY_BATCH     = 32;   // transitions per mini-batch
    var REPLAY_BATCHES   = 3;    // mini-batches replayed on each death

    function discretize(state) {
        var tti     = Math.min(TTI_BINS - 1, Math.floor(state[0] * TTI_BINS));
        var ptero   = state[1] > 0.5 ? 1 : 0;
        var jumping = state[9] > 0.5 ? 1 : 0;
        // Obstacle Y: state[2] = yPos/150. Low yPos = high on screen.
        // High ptero (yPos < 0.35) → 0, Mid (0.35–0.65) → 1, Low/ground (>0.65) → 2
        var obsY    = state[2] < 0.35 ? 0 : (state[2] < 0.65 ? 1 : 2);
        // 2nd obstacle close: state[4] < 0.3 means close
        var obs2    = state[4] < 0.3 ? 1 : 0;
        return tti + TTI_BINS * (ptero + PTERO_BINS * (jumping + JUMP_BINS * (obsY + OBS_Y_BINS * obs2)));
    }

    // -----------------------------------------------------------------------
    // Q-Learning Agent
    // -----------------------------------------------------------------------
    function QLearningAgent() {
        this.enabled = false;
        this.reset();
    }

    QLearningAgent.prototype.reset = function () {
        // Q-table: sparse object keyed by discrete state index.
        // Each entry is a Float64Array(3) of Q-values per action.
        this.Q = {};
        this.N = {};               // visit counts per state (for stats)
        this.epsilon = EPSILON_START;
        this.prevState = null;
        this.prevAction = null;

        // Experience replay buffer (ring buffer)
        this._replay = new Array(REPLAY_SIZE);
        this._replayIdx = 0;
        this._replayCount = 0;

        // Stats
        this.deaths = 0;
        this.bestScore = 0;
        this.lastScore = 0;
        this.statesVisited = 0;
        this.totalFrames = 0;
    };

    QLearningAgent.prototype._getQ = function (s) {
        if (!this.Q[s]) {
            this.Q[s] = new Float64Array(NUM_ACTIONS);
            this.statesVisited++;
        }
        return this.Q[s];
    };

    QLearningAgent.prototype._argmax = function (qValues) {
        var best = 0;
        for (var a = 1; a < NUM_ACTIONS; a++) {
            if (qValues[a] > qValues[best]) best = a;
        }
        return best;
    };

    // --- Experience replay helpers ---

    QLearningAgent.prototype._storeTransition = function (s, a, r, sNext, terminal) {
        this._replay[this._replayIdx] = { s: s, a: a, r: r, sn: sNext, t: terminal };
        this._replayIdx = (this._replayIdx + 1) % REPLAY_SIZE;
        if (this._replayCount < REPLAY_SIZE) this._replayCount++;
    };

    QLearningAgent.prototype._replayBatch = function () {
        if (this._replayCount < REPLAY_BATCH) return;
        for (var b = 0; b < REPLAY_BATCHES; b++) {
            for (var i = 0; i < REPLAY_BATCH; i++) {
                var idx = Math.floor(Math.random() * this._replayCount);
                var tr = this._replay[idx];
                var qPrev = this._getQ(tr.s);
                var oldQ = qPrev[tr.a];
                if (tr.t) {
                    qPrev[tr.a] = oldQ + ALPHA * (tr.r - oldQ);
                } else {
                    var qNext = this._getQ(tr.sn);
                    var maxNext = Math.max(qNext[0], qNext[1], qNext[2]);
                    qPrev[tr.a] = oldQ + ALPHA * (tr.r + GAMMA * maxNext - oldQ);
                }
            }
        }
    };

    /**
     * Main AI decision loop. Called each frame by the game engine.
     * @param {Runner} runner
     */
    QLearningAgent.prototype.update = function (runner) {
        if (!runner.playing) return;

        var state = window.dinoShared.extractState(runner);
        var sKey = discretize(state);

        // --- Bellman update for the previous (state, action) ---
        if (this.prevState !== null) {
            var qPrev = this._getQ(this.prevState);
            var qNow  = this._getQ(sKey);
            var maxNextQ = Math.max(qNow[0], qNow[1], qNow[2]);
            var oldQ = qPrev[this.prevAction];
            qPrev[this.prevAction] = oldQ +
                ALPHA * (ALIVE_REWARD + GAMMA * maxNextQ - oldQ);

            // Store transition for replay
            this._storeTransition(this.prevState, this.prevAction, ALIVE_REWARD, sKey, false);
        }

        // --- Epsilon-greedy action selection ---
        var action;
        if (Math.random() < this.epsilon) {
            action = Math.floor(Math.random() * NUM_ACTIONS);
        } else {
            action = this._argmax(this._getQ(sKey));
        }

        window.dinoShared.executeAction(action, runner);

        // Track visit counts
        if (!this.N[sKey]) this.N[sKey] = 0;
        this.N[sKey]++;

        this.prevState = sKey;
        this.prevAction = action;
        this.totalFrames++;

        // Decay exploration
        if (this.epsilon > EPSILON_MIN) {
            this.epsilon *= EPSILON_DECAY;
        }
    };

    /**
     * Called on crash by the game engine.
     * @param {Runner} runner
     */
    QLearningAgent.prototype.onCrash = function (runner) {
        // Terminal Bellman update — no next state.
        if (this.prevState !== null) {
            var qPrev = this._getQ(this.prevState);
            var oldQ = qPrev[this.prevAction];
            qPrev[this.prevAction] = oldQ + ALPHA * (DEATH_PENALTY - oldQ);

            // Store terminal transition for replay
            this._storeTransition(this.prevState, this.prevAction, DEATH_PENALTY, 0, true);
        }
        this.prevState = null;
        this.prevAction = null;

        // Experience replay: extract more learning from past transitions
        this._replayBatch();

        this.deaths++;
        var score = Math.round(runner.distanceRan * 0.025);
        this.lastScore = score;
        if (score > this.bestScore) this.bestScore = score;

        this._updateStats();
    };

    /** No-op — required by the game engine contract. */
    QLearningAgent.prototype.recordPrediction = function () {};

    /** Update the stats display element. */
    QLearningAgent.prototype._updateStats = function () {
        var el = document.getElementById('q-stats');
        if (!el) return;
        el.textContent =
            'Deaths: ' + this.deaths +
            ' | Best: ' + this.bestScore +
            ' | Last: ' + this.lastScore +
            ' | \u03b5: ' + this.epsilon.toFixed(3) +
            ' | States: ' + this.statesVisited + '/' + NUM_STATES;
    };

    /**
     * Pre-fill Q-table from pre-saved gameplay data (overridden below
     * to use teacher predictions when available).
     */
    QLearningAgent.prototype.warmStart = function () {};

    // -----------------------------------------------------------------------
    // Visualization — policy heatmap (new layout for obsHeight + obs2Close)
    // -----------------------------------------------------------------------

    var ACTION_LABELS = ['R', 'J', 'D'];
    var ACTION_BG     = ['#e8e8ed', '#4a9eff', '#e8a735']; // run, jump, duck
    var OBS_Y_LABELS  = ['High', 'Mid', 'Low'];
    var ROW_LABELS    = ['Cactus', 'Ptero'];

    QLearningAgent.prototype.renderPolicy = function (containerId) {
        var el = document.getElementById(containerId);
        if (!el) return;

        var html = '<div class="q-policy-header">';
        html += '<span class="q-legend"><span class="q-lg-swatch" style="background:#e8e8ed;border:1px solid #ccc"></span> Run</span>';
        html += '<span class="q-legend"><span class="q-lg-swatch" style="background:#4a9eff"></span> Jump</span>';
        html += '<span class="q-legend"><span class="q-lg-swatch" style="background:#e8a735"></span> Duck</span>';
        html += '<span class="q-legend"><span class="q-lg-swatch" style="background:#fff;border:1px dashed #ccc"></span> Unvisited</span>';
        html += '</div>';

        // Layout: 2 sub-tables (obs2=far, obs2=close), each has 3 obsY groups × 2 ptero rows
        var obs2Labels = ['Single Obstacle', 'Double Obstacle'];
        for (var obs2 = 0; obs2 < OBS2_BINS; obs2++) {
            html += '<div class="q-subtable-label">' + obs2Labels[obs2] + '</div>';
            html += '<table class="q-policy-table"><thead><tr><th></th><th></th>';
            for (var t = 0; t < TTI_BINS; t++) {
                html += '<th>' + t + '</th>';
            }
            html += '</tr></thead><tbody>';

            for (var obsY = 0; obsY < OBS_Y_BINS; obsY++) {
                for (var ptero = 0; ptero < PTERO_BINS; ptero++) {
                    html += '<tr>';
                    if (ptero === 0) {
                        html += '<td class="q-speed-label" rowspan="2">' + OBS_Y_LABELS[obsY] + '</td>';
                    }
                    html += '<td class="q-row-label">' + ROW_LABELS[ptero] + '</td>';

                    for (var tti = 0; tti < TTI_BINS; tti++) {
                        var jumping = 0; // ground states only
                        var sKey = tti + TTI_BINS * (ptero + PTERO_BINS * (jumping + JUMP_BINS * (obsY + OBS_Y_BINS * obs2)));
                        var q = this.Q[sKey];
                        if (q) {
                            var best = 0;
                            for (var a = 1; a < NUM_ACTIONS; a++) {
                                if (q[a] > q[best]) best = a;
                            }
                            var sorted = [q[0], q[1], q[2]].sort(function (a, b) { return b - a; });
                            var gap = sorted[0] - sorted[1];
                            var confidence = Math.min(1, gap / 20);
                            var opacity = (0.35 + 0.65 * confidence).toFixed(2);
                            html += '<td class="q-cell" style="background:' + ACTION_BG[best] +
                                ';opacity:' + opacity + '">' + ACTION_LABELS[best] + '</td>';
                        } else {
                            html += '<td class="q-cell q-unvisited"></td>';
                        }
                    }
                    html += '</tr>';
                }
                if (obsY < OBS_Y_BINS - 1) {
                    html += '<tr class="q-separator"><td colspan="' + (TTI_BINS + 2) + '"></td></tr>';
                }
            }

            html += '</tbody></table>';
        }
        html += '<div class="q-policy-footer">\u2190 Close &nbsp;&nbsp; Time to Impact &nbsp;&nbsp; Far \u2192</div>';

        el.innerHTML = html;
    };

    // -----------------------------------------------------------------------
    // Cached (pre-computed) policy — strong Q-table from offline Bellman
    // -----------------------------------------------------------------------

    var _cachedQ = null; // lazily computed on first play

    /**
     * Build a strong Q-table by running many Bellman passes over presaved data.
     * Uses teacher network predictions for actions (much more signal than
     * transition-only labels). Returns a Q-table object keyed by discrete state.
     */
    function computeCachedPolicy() {
        if (_cachedQ) return _cachedQ;
        if (!window.PRESAVED_GAMEPLAY) return null;

        var samples = window.PRESAVED_GAMEPLAY;
        var teacher = window._precomputedTeacher ? window._precomputedTeacher.net : null;
        var useTeacher = teacher && window.forwardWithActivations;

        // Pre-compute discrete states and actions for all frames
        var processed = [];
        for (var i = 0; i < samples.length; i++) {
            var s = samples[i];
            var input = new Float64Array(s.slice(0, 12));
            var action;
            if (useTeacher) {
                var acts = window.forwardWithActivations(input, teacher);
                var out = acts[acts.length - 1];
                action = 0;
                for (var a = 1; a < NUM_ACTIONS; a++) {
                    if (out[a] > out[action]) action = a;
                }
            } else {
                action = s[12];
            }
            processed.push({ sKey: discretize(input), action: action });
        }

        // Build Q-table with 50 Bellman passes (full convergence)
        var Q = {};
        function getQ(s) {
            if (!Q[s]) Q[s] = new Float64Array(NUM_ACTIONS);
            return Q[s];
        }
        for (var pass = 0; pass < 50; pass++) {
            for (var i = 0; i < processed.length - 1; i++) {
                var p = processed[i];
                var pNext = processed[i + 1];
                var qPrev = getQ(p.sKey);
                var qNext = getQ(pNext.sKey);
                var maxNextQ = Math.max(qNext[0], qNext[1], qNext[2]);
                var oldQ = qPrev[p.action];
                qPrev[p.action] = oldQ + ALPHA * (ALIVE_REWARD + GAMMA * maxNextQ - oldQ);
            }
        }
        _cachedQ = Q;
        return Q;
    }

    /**
     * Create a greedy agent that plays using the cached Q-policy.
     * Returns an agent object compatible with runner.aiAgent.
     */
    function createCachedAgent() {
        var Q = computeCachedPolicy();
        if (!Q) return null;

        var deaths = 0;
        var bestScore = 0;

        return {
            enabled: true,
            _Q: Q,
            _deaths: 0,
            _bestScore: 0,
            update: function (runner) {
                if (!runner.playing) return;
                var state = window.dinoShared.extractState(runner);
                var sKey = discretize(state);
                var q = Q[sKey];
                var action = 0; // default: run
                if (q) {
                    for (var a = 1; a < NUM_ACTIONS; a++) {
                        if (q[a] > q[action]) action = a;
                    }
                }
                window.dinoShared.executeAction(action, runner);
            },
            onCrash: function (runner) {
                this._deaths++;
                var score = Math.round(runner.distanceRan * 0.025);
                if (score > this._bestScore) this._bestScore = score;
            },
            recordPrediction: function () {}
        };
    }

    /**
     * Render the cached policy heatmap using a temporary agent wrapper.
     */
    function renderCachedPolicy(containerId) {
        var Q = computeCachedPolicy();
        if (!Q) return;
        // Create a thin wrapper with the Q-table for rendering
        var wrapper = { Q: Q, statesVisited: Object.keys(Q).length };
        QLearningAgent.prototype.renderPolicy.call(wrapper, containerId);
    }

    // -----------------------------------------------------------------------
    // Also update warmStart to use teacher predictions when available
    // -----------------------------------------------------------------------
    var _origWarmStart = QLearningAgent.prototype.warmStart;
    QLearningAgent.prototype.warmStart = function () {
        if (!window.PRESAVED_GAMEPLAY) return;
        var samples = window.PRESAVED_GAMEPLAY;
        var teacher = window._precomputedTeacher ? window._precomputedTeacher.net : null;
        var useTeacher = teacher && window.forwardWithActivations;

        // Pre-compute actions using teacher if available
        var processed = [];
        for (var i = 0; i < samples.length; i++) {
            var s = samples[i];
            var input = new Float64Array(s.slice(0, 12));
            var action;
            if (useTeacher) {
                var acts = window.forwardWithActivations(input, teacher);
                var out = acts[acts.length - 1];
                action = 0;
                for (var a = 1; a < NUM_ACTIONS; a++) {
                    if (out[a] > out[action]) action = a;
                }
            } else {
                action = s[12];
            }
            processed.push({ sKey: discretize(input), action: action });
        }

        // Run 10 passes for warm start
        for (var pass = 0; pass < 10; pass++) {
            for (var i = 0; i < processed.length - 1; i++) {
                var p = processed[i];
                var pNext = processed[i + 1];
                var qPrev = this._getQ(p.sKey);
                var qNext = this._getQ(pNext.sKey);
                var maxNextQ = Math.max(qNext[0], qNext[1], qNext[2]);
                var oldQ = qPrev[p.action];
                qPrev[p.action] = oldQ + ALPHA * (ALIVE_REWARD + GAMMA * maxNextQ - oldQ);
            }
        }
        this.epsilon = 0.15;
    };

    // -----------------------------------------------------------------------
    // Expose
    // -----------------------------------------------------------------------
    window.QLearningAgent = QLearningAgent;
    window.createCachedQAgent = createCachedAgent;
    window.renderCachedQPolicy = renderCachedPolicy;

})();
