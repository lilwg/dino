// =============================================================================
// Logistic Regression Agent — Simplest learned model for Chrome Dino game.
//
// 12 inputs -> 3 outputs (softmax). 39 parameters total (36 weights + 3 biases).
// Trained via mini-batch SGD on gameplay data collected from the sim AI.
//
// Depends on: window.dinoShared (extractState, executeAction) from rl-agent.js
//             AIAgent (from ai-agent.js) for data collection
// =============================================================================
(function () {
    'use strict';

    var NUM_FEATURES = 12;
    var NUM_ACTIONS  = 3;
    var TARGET_FRAMES = 6000;
    var FEATURE_NAMES = [
        'dist\u2081', 'ptero\u2081', 'yPos\u2081', 'width\u2081',
        'dist\u2082', 'ptero\u2082', 'yPos\u2082',
        'speed', 'jumpH', 'jumping', 'ducking', 'height\u2081'
    ];
    var ACTION_NAMES = ['RUN', 'JUMP', 'DUCK'];

    // -----------------------------------------------------------------------
    // Model: W (3x12) + b (3) = 39 parameters
    // -----------------------------------------------------------------------
    var W = null; // Float64Array(36), row-major [action * 12 + feature]
    var b = null; // Float64Array(3)

    function initWeights() {
        W = new Float64Array(NUM_ACTIONS * NUM_FEATURES);
        b = new Float64Array(NUM_ACTIONS);
        // Small random initialization
        for (var i = 0; i < W.length; i++) {
            W[i] = (Math.random() - 0.5) * 0.1;
        }
    }

    /**
     * Forward pass: compute logits, then softmax.
     * @param {Float64Array} x Input features (12)
     * @return {Float64Array} Probabilities (3)
     */
    function forwardPass(x) {
        var logits = new Float64Array(NUM_ACTIONS);
        for (var a = 0; a < NUM_ACTIONS; a++) {
            logits[a] = b[a];
            for (var f = 0; f < NUM_FEATURES; f++) {
                logits[a] += W[a * NUM_FEATURES + f] * x[f];
            }
        }
        return softmax(logits);
    }

    function softmax(logits) {
        var maxVal = -Infinity;
        for (var i = 0; i < logits.length; i++) {
            if (logits[i] > maxVal) maxVal = logits[i];
        }
        var sum = 0;
        var out = new Float64Array(logits.length);
        for (var i = 0; i < logits.length; i++) {
            out[i] = Math.exp(logits[i] - maxVal);
            sum += out[i];
        }
        for (var i = 0; i < logits.length; i++) out[i] /= sum;
        return out;
    }

    function argmax(arr) {
        var best = 0;
        for (var i = 1; i < arr.length; i++) {
            if (arr[i] > arr[best]) best = i;
        }
        return best;
    }

    // -----------------------------------------------------------------------
    // Data collection — watch the sim AI play (same pattern as decision-tree.js)
    // -----------------------------------------------------------------------

    function collectSimData(runner, targetFrames, onProgress, callback) {
        var simAgent = new window.AIAgent();
        simAgent.enabled = true;
        var dataset = [];

        var wrapper = {
            enabled: true,
            update: function (r) {
                if (!r.playing) return;
                var state = window.dinoShared.extractState(r);
                var wasJumping = r.tRex.jumping;
                var wasDucking = r.tRex.ducking;

                simAgent.update(r);

                var action = 0;
                if (r.tRex.jumping && !wasJumping) action = 1;
                else if (r.tRex.ducking && !wasDucking) action = 2;
                else if (r.tRex.speedDrop) action = 2;

                dataset.push({ input: state, label: action });

                if (onProgress && dataset.length % 300 === 0) {
                    onProgress(dataset.length, targetFrames);
                }

                if (dataset.length >= targetFrames) {
                    r.aiAgent = null;
                    callback(dataset);
                }
            },
            onCrash: function (r) { simAgent.onCrash(r); },
            recordPrediction: function () {}
        };

        runner.aiAgent = wrapper;
        runner.suppressCollision = false;
        if (runner.crashed || !runner.playing) {
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

    // -----------------------------------------------------------------------
    // SGD Training
    // -----------------------------------------------------------------------

    /**
     * Shuffle array in place (Fisher-Yates).
     */
    function shuffle(arr) {
        for (var i = arr.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        }
    }

    /**
     * Train logistic regression via mini-batch SGD.
     * Runs in chunks via setTimeout to keep UI responsive.
     * @param {Array} dataset Training data
     * @param {number} nEpochs Total epochs
     * @param {function} onProgress Called with (epoch, loss, accuracy)
     * @param {function} onDone Called when training completes
     */
    function trainSGD(dataset, nEpochs, onProgress, onDone) {
        var lr = 0.1;
        var batchSize = 32;
        var lossHistory = [];
        var epoch = 0;
        var CHUNK = 10; // epochs per setTimeout chunk

        function runChunk() {
            var end = Math.min(epoch + CHUNK, nEpochs);
            for (; epoch < end; epoch++) {
                shuffle(dataset);
                var epochLoss = 0;

                for (var bStart = 0; bStart < dataset.length; bStart += batchSize) {
                    var bEnd = Math.min(bStart + batchSize, dataset.length);
                    var gW = new Float64Array(NUM_ACTIONS * NUM_FEATURES);
                    var gb = new Float64Array(NUM_ACTIONS);

                    for (var s = bStart; s < bEnd; s++) {
                        var x = dataset[s].input;
                        var label = dataset[s].label;

                        var probs = forwardPass(x);
                        epochLoss -= Math.log(probs[label] + 1e-10);

                        // Gradient: dL/dlogit_a = probs[a] - 1(a==label)
                        for (var a = 0; a < NUM_ACTIONS; a++) {
                            var delta = probs[a] - (a === label ? 1 : 0);
                            gb[a] += delta;
                            for (var f = 0; f < NUM_FEATURES; f++) {
                                gW[a * NUM_FEATURES + f] += delta * x[f];
                            }
                        }
                    }

                    // Apply gradients
                    var scale = lr / (bEnd - bStart);
                    for (var i = 0; i < gW.length; i++) W[i] -= scale * gW[i];
                    for (var i = 0; i < gb.length; i++) b[i] -= scale * gb[i];
                }

                lossHistory.push(epochLoss / dataset.length);
            }

            // Report progress
            var acc = computeAccuracy(dataset);
            if (onProgress) onProgress(epoch, lossHistory, acc);

            if (epoch < nEpochs) {
                setTimeout(runChunk, 0);
            } else {
                if (onDone) onDone(lossHistory, acc);
            }
        }

        runChunk();
    }

    /**
     * Compute classification accuracy on a dataset.
     */
    function computeAccuracy(dataset) {
        var correct = 0;
        for (var i = 0; i < dataset.length; i++) {
            var probs = forwardPass(dataset[i].input);
            if (argmax(probs) === dataset[i].label) correct++;
        }
        return correct / dataset.length;
    }

    // -----------------------------------------------------------------------
    // Visualization — loss curve
    // -----------------------------------------------------------------------

    function renderLossCurve(canvasId, lossHistory) {
        var canvas = document.getElementById(canvasId);
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        var W_C = canvas.width, H_C = canvas.height;
        var padL = 45, padR = 15, padT = 12, padB = 22;
        var plotW = W_C - padL - padR;
        var plotH = H_C - padT - padB;

        ctx.clearRect(0, 0, W_C, H_C);

        if (lossHistory.length < 2) return;

        var maxLoss = 0;
        for (var i = 0; i < lossHistory.length; i++) {
            if (lossHistory[i] > maxLoss) maxLoss = lossHistory[i];
        }
        maxLoss = Math.max(maxLoss, 0.1);

        // Axes
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, padT);
        ctx.lineTo(padL, padT + plotH);
        ctx.lineTo(padL + plotW, padT + plotH);
        ctx.stroke();

        // Labels
        ctx.fillStyle = '#888';
        ctx.font = '11px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(maxLoss.toFixed(2), padL - 5, padT + 10);
        ctx.fillText('0', padL - 5, padT + plotH);
        ctx.textAlign = 'center';
        ctx.fillText('Epoch', padL + plotW / 2, H_C - 5);
        ctx.fillText('0', padL, H_C - 5);
        ctx.fillText(String(lossHistory.length), padL + plotW, H_C - 5);

        // Loss curve
        ctx.strokeStyle = '#4a9eff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (var i = 0; i < lossHistory.length; i++) {
            var x = padL + (i / (lossHistory.length - 1)) * plotW;
            var y = padT + plotH - (lossHistory[i] / maxLoss) * plotH;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    // -----------------------------------------------------------------------
    // Visualization — weight matrix (with live animation support)
    // -----------------------------------------------------------------------

    function renderWeightMatrix(containerId) {
        var el = document.getElementById(containerId);
        if (!el || !W) return;

        var maxW = 0;
        for (var i = 0; i < W.length; i++) {
            if (Math.abs(W[i]) > maxW) maxW = Math.abs(W[i]);
        }
        if (maxW === 0) maxW = 1;

        var html = '<table class="weight-matrix">';
        html += '<tr><th></th>';
        for (var f = 0; f < NUM_FEATURES; f++) {
            html += '<th>' + FEATURE_NAMES[f] + '</th>';
        }
        html += '<th>bias</th><th></th></tr>';

        for (var a = 0; a < NUM_ACTIONS; a++) {
            html += '<tr data-row="' + a + '"><td class="action-label">' + ACTION_NAMES[a] + '</td>';
            for (var f = 0; f < NUM_FEATURES; f++) {
                var w = W[a * NUM_FEATURES + f];
                var intensity = Math.abs(w) / maxW;
                var color;
                if (w >= 0) {
                    color = 'rgba(74,158,255,' + (intensity * 0.8).toFixed(2) + ')';
                } else {
                    color = 'rgba(232,100,100,' + (intensity * 0.8).toFixed(2) + ')';
                }
                html += '<td data-w="' + a + '-' + f + '" style="background:' + color + '">' +
                    w.toFixed(2) + '</td>';
            }
            var bv = b[a];
            var bIntensity = Math.abs(bv) / Math.max(maxW, 1);
            var bColor = bv >= 0 ?
                'rgba(74,158,255,' + (bIntensity * 0.8).toFixed(2) + ')' :
                'rgba(232,100,100,' + (bIntensity * 0.8).toFixed(2) + ')';
            html += '<td style="background:' + bColor + '">' +
                bv.toFixed(2) + '</td>';
            html += '<td data-prob="' + a + '" style="font-size:10px;color:#86868b;min-width:36px;text-align:right;"></td>';
            html += '</tr>';
        }
        html += '</table>';
        el.innerHTML = html;
    }

    // -----------------------------------------------------------------------
    // Live weight matrix animation — highlights the active decision
    // -----------------------------------------------------------------------

    /**
     * Update the weight matrix to show live contributions for the current state.
     * Highlights the winning action row and shows per-cell contribution intensity.
     * @param {string} containerId - DOM element ID
     * @param {Float64Array} state - Current 12-feature state vector
     */
    function updateLiveMatrix(containerId, state) {
        var el = document.getElementById(containerId);
        if (!el || !W) return;

        // Compute logits and find winner
        var logits = new Float64Array(NUM_ACTIONS);
        for (var a = 0; a < NUM_ACTIONS; a++) {
            logits[a] = b[a];
            for (var f = 0; f < NUM_FEATURES; f++) {
                logits[a] += W[a * NUM_FEATURES + f] * state[f];
            }
        }
        var probs = softmax(logits);
        var winner = argmax(probs);

        // Find max contribution magnitude for scaling
        var maxContrib = 0.01;
        for (var a = 0; a < NUM_ACTIONS; a++) {
            for (var f = 0; f < NUM_FEATURES; f++) {
                var c = Math.abs(W[a * NUM_FEATURES + f] * state[f]);
                if (c > maxContrib) maxContrib = c;
            }
        }

        // Update cells using IDs set during renderWeightMatrix
        for (var a = 0; a < NUM_ACTIONS; a++) {
            var isWinner = (a === winner);
            // Update row label
            var rowLabel = el.querySelector('[data-row="' + a + '"] .action-label');
            if (rowLabel) {
                rowLabel.style.color = isWinner ? '#0071e3' : '#1d1d1f';
                rowLabel.style.fontWeight = isWinner ? '800' : '600';
            }
            // Update probability cell
            var probCell = el.querySelector('[data-prob="' + a + '"]');
            if (probCell) {
                probCell.textContent = (probs[a] * 100).toFixed(0) + '%';
                probCell.style.fontWeight = isWinner ? '800' : '400';
                probCell.style.color = isWinner ? '#0071e3' : '#86868b';
            }
            // Update weight cells with contribution intensity
            for (var f = 0; f < NUM_FEATURES; f++) {
                var cell = el.querySelector('[data-w="' + a + '-' + f + '"]');
                if (!cell) continue;
                var contrib = W[a * NUM_FEATURES + f] * state[f];
                var intensity = Math.abs(contrib) / maxContrib;
                if (contrib >= 0) {
                    cell.style.background = 'rgba(74,158,255,' + (intensity * 0.7).toFixed(2) + ')';
                } else {
                    cell.style.background = 'rgba(232,100,100,' + (intensity * 0.7).toFixed(2) + ')';
                }
                cell.style.fontWeight = (intensity > 0.4 && isWinner) ? '700' : '400';
            }
        }
    }

    // -----------------------------------------------------------------------
    // Stored state
    // -----------------------------------------------------------------------
    var _trained = false;
    var _playing = false;
    var _deaths = 0;
    var _bestScore = 0;
    var _statsInterval = null;

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Train the logistic regression model from sim AI gameplay data.
     */
    window.trainLogisticModel = function () {
        var runner = window.logRunner;
        if (!runner) return;

        var statusEl = document.getElementById('log-stats');
        var vizBox = document.getElementById('log-viz-box');
        var playBtn = document.getElementById('log-play-btn');
        if (playBtn) playBtn.style.display = 'none';
        if (vizBox) vizBox.style.display = 'none';

        // Stop any existing playback.
        runner.aiAgent = null;
        if (_statsInterval) { clearInterval(_statsInterval); _statsInterval = null; }
        _trained = false;

        // Initialize fresh weights.
        initWeights();

        // Shared training callback (used by both fast path and live collection).
        function startSGD(dataset) {
            if (statusEl) statusEl.textContent = 'Training (epoch 0/200)...';
            if (vizBox) vizBox.style.display = 'block';

            trainSGD(dataset, 200,
                function onProgress(epoch, lossHistory, acc) {
                    if (statusEl) statusEl.textContent =
                        'Training: epoch ' + epoch + '/200' +
                        ' | Loss: ' + lossHistory[lossHistory.length - 1].toFixed(4) +
                        ' | Accuracy: ' + (acc * 100).toFixed(1) + '%';
                    renderLossCurve('log-loss-canvas', lossHistory);

                    renderWeightMatrix('log-weights-display');
                },
                function onDone(lossHistory, acc) {
                    _trained = true;
                    if (statusEl) statusEl.textContent =
                        'Trained! Accuracy: ' + (acc * 100).toFixed(1) +
                        '% | 39 parameters | Loss: ' +
                        lossHistory[lossHistory.length - 1].toFixed(4);
                    renderLossCurve('log-loss-canvas', lossHistory);

                    renderWeightMatrix('log-weights-display');
                    if (playBtn) playBtn.style.display = '';
                });
        }

        // Fast path: use pre-saved multi-speed gameplay data if available.
        if (window.PRESAVED_GAMEPLAY) {
            if (statusEl) statusEl.textContent = 'Training from ' +
                window.PRESAVED_GAMEPLAY.length + ' pre-saved frames...';
            var dataset = [];
            var samples = window.PRESAVED_GAMEPLAY;
            for (var i = 0; i < samples.length; i++) {
                var s = samples[i];
                dataset.push({
                    input: new Float64Array(s.slice(0, 12)),
                    label: s[12]
                });
            }
            startSGD(dataset);
            return;
        }

        // Fallback: live data collection from sim AI.
        if (statusEl) statusEl.textContent = 'Collecting sim AI gameplay data...';

        collectSimData(runner, TARGET_FRAMES,
            function onProgress(n, total) {
                if (statusEl) statusEl.textContent =
                    'Collecting data: ' + n + ' / ' + total + ' frames';
            },
            function onDone(dataset) {
                startSGD(dataset);
            });
    };

    /**
     * Toggle the trained logistic regression model playback.
     */
    window.playLogisticModel = function () {
        var runner = window.logRunner;
        var playBtn = document.getElementById('log-play-btn');

        // Toggle off if already playing
        if (_playing) {
            _playing = false;
            if (runner) runner.aiAgent = null;
            if (playBtn) playBtn.classList.remove('active');
            if (_statsInterval) { clearInterval(_statsInterval); _statsInterval = null; }
            return;
        }

        if (!_trained || !W || !runner) return;

        _playing = true;
        _deaths = 0;
        _bestScore = 0;
        if (playBtn) playBtn.classList.add('active');

        var statusEl = document.getElementById('log-stats');

        var _frameCount = 0;
        var agent = {
            enabled: true,
            update: function (r) {
                if (!r.playing) return;
                var state = window.dinoShared.extractState(r);
                var probs = forwardPass(state);
                var action = argmax(probs);
                window.dinoShared.executeAction(action, r);
                // Animate weight matrix every 6th frame (~10fps)
                _frameCount++;
                if (_frameCount % 6 === 0) {
                    updateLiveMatrix('log-weights-display', state);
                }
            },
            onCrash: function (r) {
                _deaths++;
                var score = Math.round(r.distanceRan * 0.025);
                if (score > _bestScore) _bestScore = score;
            },
            recordPrediction: function () {}
        };

        runner.aiAgent = agent;
        runner.suppressCollision = false;

        if (runner.crashed || !runner.playing) {
            runner.playing = true;
            runner.activated = true;
            runner.tRex.playingIntro = false;
            runner.playingIntro = false;
            runner.setArcadeMode();
            runner.containerEl.style.width = runner.dimensions.WIDTH + 'px';
            runner.tRex.startJump(runner.currentSpeed);
            runner.update();
        }

        if (_statsInterval) clearInterval(_statsInterval);
        _statsInterval = setInterval(function () {
            if (!_playing || !runner.aiAgent || !runner.aiAgent.enabled) {
                clearInterval(_statsInterval);
                _statsInterval = null;
                return;
            }
            var score = Math.round(runner.distanceRan * 0.025);
            if (statusEl) {
                statusEl.textContent =
                    'Deaths: ' + _deaths +
                    ' | Best: ' + _bestScore +
                    ' | Score: ' + score;
            }
        }, 200);
    };

    /**
     * Stop logistic model playback.
     */
    window.stopLogisticModel = function () {
        _playing = false;
        var runner = window.logRunner;
        if (runner) runner.aiAgent = null;
        if (_statsInterval) { clearInterval(_statsInterval); _statsInterval = null; }
        var playBtn = document.getElementById('log-play-btn');
        if (playBtn) playBtn.classList.remove('active');
    };

})();
