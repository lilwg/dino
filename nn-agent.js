// =============================================================================
// Neural Network (MLP) Agent — Backpropagation-trained for Chrome Dino game.
//
// A simple 2-layer MLP (12 -> 16 -> 3) trained via mini-batch SGD with
// backpropagation on gameplay data collected from the sim AI.
// This bridges the gap between logistic regression (no hidden layers) and
// neuroevolution (hidden layers but no gradient descent).
//
// Depends on: window.dinoShared (extractState, executeAction) from rl-agent.js
//             AIAgent (from ai-agent.js) for data collection
// =============================================================================
(function () {
    'use strict';

    var NUM_FEATURES = 12;
    var NUM_HIDDEN   = 16;
    var NUM_ACTIONS  = 3;
    var TARGET_FRAMES = 6000;
    var FEATURE_NAMES = [
        'dist\u2081', 'ptero\u2081', 'yPos\u2081', 'width\u2081',
        'dist\u2082', 'ptero\u2082', 'yPos\u2082',
        'speed', 'jumpH', 'jumping', 'ducking', 'height\u2081'
    ];
    var ACTION_NAMES = ['RUN', 'JUMP', 'DUCK'];

    // -----------------------------------------------------------------------
    // Model: 12 -> 16 (ReLU) -> 3 (softmax)
    //   W1: 16x12 = 192, b1: 16
    //   W2: 3x16  = 48,  b2: 3
    //   Total: 259 parameters
    // -----------------------------------------------------------------------
    var W1 = null; // Float64Array(192), row-major [hidden * 12 + feature]
    var b1 = null; // Float64Array(16)
    var W2 = null; // Float64Array(48),  row-major [action * 16 + hidden]
    var b2 = null; // Float64Array(3)

    function initWeights() {
        // Xavier initialization
        var scale1 = Math.sqrt(2.0 / NUM_FEATURES);
        var scale2 = Math.sqrt(2.0 / NUM_HIDDEN);

        W1 = new Float64Array(NUM_HIDDEN * NUM_FEATURES);
        b1 = new Float64Array(NUM_HIDDEN);
        W2 = new Float64Array(NUM_ACTIONS * NUM_HIDDEN);
        b2 = new Float64Array(NUM_ACTIONS);

        for (var i = 0; i < W1.length; i++) {
            W1[i] = (Math.random() - 0.5) * 2 * scale1;
        }
        for (var i = 0; i < W2.length; i++) {
            W2[i] = (Math.random() - 0.5) * 2 * scale2;
        }
    }

    /**
     * Forward pass returning all intermediate activations for backprop.
     * @param {Float64Array} x Input features (12)
     * @return {Object} { hidden, hiddenRaw, output, logits }
     */
    function forwardFull(x) {
        // Hidden layer: z1 = W1 * x + b1, h = ReLU(z1)
        var hiddenRaw = new Float64Array(NUM_HIDDEN);
        var hidden = new Float64Array(NUM_HIDDEN);
        for (var h = 0; h < NUM_HIDDEN; h++) {
            hiddenRaw[h] = b1[h];
            for (var f = 0; f < NUM_FEATURES; f++) {
                hiddenRaw[h] += W1[h * NUM_FEATURES + f] * x[f];
            }
            hidden[h] = hiddenRaw[h] > 0 ? hiddenRaw[h] : 0; // ReLU
        }

        // Output layer: z2 = W2 * h + b2, output = softmax(z2)
        var logits = new Float64Array(NUM_ACTIONS);
        for (var a = 0; a < NUM_ACTIONS; a++) {
            logits[a] = b2[a];
            for (var h = 0; h < NUM_HIDDEN; h++) {
                logits[a] += W2[a * NUM_HIDDEN + h] * hidden[h];
            }
        }

        var output = softmax(logits);
        return { hidden: hidden, hiddenRaw: hiddenRaw, output: output, logits: logits };
    }

    /**
     * Simple forward pass for inference.
     */
    function forwardPass(x) {
        return forwardFull(x).output;
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
    // Data collection — watch the sim AI play
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
    // SGD Training with Backpropagation
    // -----------------------------------------------------------------------

    function shuffle(arr) {
        for (var i = arr.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        }
    }

    /**
     * Train MLP via mini-batch SGD with backpropagation.
     * Runs in chunks via setTimeout to keep UI responsive.
     */
    function trainSGD(dataset, nEpochs, onProgress, onDone) {
        var lr = 0.05;
        var batchSize = 32;
        var lossHistory = [];
        var epoch = 0;
        var CHUNK = 5; // epochs per setTimeout chunk

        function runChunk() {
            var end = Math.min(epoch + CHUNK, nEpochs);
            for (; epoch < end; epoch++) {
                shuffle(dataset);
                var epochLoss = 0;

                for (var bStart = 0; bStart < dataset.length; bStart += batchSize) {
                    var bEnd = Math.min(bStart + batchSize, dataset.length);

                    // Gradient accumulators
                    var gW1 = new Float64Array(NUM_HIDDEN * NUM_FEATURES);
                    var gb1 = new Float64Array(NUM_HIDDEN);
                    var gW2 = new Float64Array(NUM_ACTIONS * NUM_HIDDEN);
                    var gb2 = new Float64Array(NUM_ACTIONS);

                    for (var s = bStart; s < bEnd; s++) {
                        var x = dataset[s].input;
                        var label = dataset[s].label;

                        // Forward pass
                        var fwd = forwardFull(x);
                        epochLoss -= Math.log(fwd.output[label] + 1e-10);

                        // --- Backpropagation ---
                        // Output layer gradient: dL/dlogit_a = probs[a] - 1(a==label)
                        var dLogits = new Float64Array(NUM_ACTIONS);
                        for (var a = 0; a < NUM_ACTIONS; a++) {
                            dLogits[a] = fwd.output[a] - (a === label ? 1 : 0);
                        }

                        // Gradients for W2, b2
                        for (var a = 0; a < NUM_ACTIONS; a++) {
                            gb2[a] += dLogits[a];
                            for (var h = 0; h < NUM_HIDDEN; h++) {
                                gW2[a * NUM_HIDDEN + h] += dLogits[a] * fwd.hidden[h];
                            }
                        }

                        // Hidden layer gradient: dL/dh = W2^T * dLogits
                        var dHidden = new Float64Array(NUM_HIDDEN);
                        for (var h = 0; h < NUM_HIDDEN; h++) {
                            for (var a = 0; a < NUM_ACTIONS; a++) {
                                dHidden[h] += W2[a * NUM_HIDDEN + h] * dLogits[a];
                            }
                            // ReLU derivative
                            if (fwd.hiddenRaw[h] <= 0) dHidden[h] = 0;
                        }

                        // Gradients for W1, b1
                        for (var h = 0; h < NUM_HIDDEN; h++) {
                            gb1[h] += dHidden[h];
                            for (var f = 0; f < NUM_FEATURES; f++) {
                                gW1[h * NUM_FEATURES + f] += dHidden[h] * x[f];
                            }
                        }
                    }

                    // Apply gradients
                    var scale = lr / (bEnd - bStart);
                    for (var i = 0; i < gW2.length; i++) W2[i] -= scale * gW2[i];
                    for (var i = 0; i < gb2.length; i++) b2[i] -= scale * gb2[i];
                    for (var i = 0; i < gW1.length; i++) W1[i] -= scale * gW1[i];
                    for (var i = 0; i < gb1.length; i++) b1[i] -= scale * gb1[i];
                }

                lossHistory.push(epochLoss / dataset.length);
            }

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
        ctx.strokeStyle = '#30d158';
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
    // Visualization — network diagram (SVG)
    // -----------------------------------------------------------------------

    function renderNetworkDiagram(containerId, activeState) {
        var el = document.getElementById(containerId);
        if (!el || !W1 || !W2) return;

        var svgW = 600, svgH = 260;
        var layerX = [80, 300, 520]; // input, hidden, output
        var inputLabels = FEATURE_NAMES;
        var hiddenCount = NUM_HIDDEN;
        var outputLabels = ACTION_NAMES;

        // Compute activations if state is provided
        var inputAct = activeState || null;
        var hiddenAct = null;
        var outputAct = null;
        var winner = -1;
        if (inputAct) {
            var fwd = forwardFull(inputAct);
            hiddenAct = fwd.hidden;
            outputAct = fwd.output;
            winner = argmax(outputAct);
        }

        // Node positions
        var inputY = [], hiddenY = [], outputY = [];
        var inputSpacing = Math.min(20, (svgH - 20) / NUM_FEATURES);
        var inputStart = (svgH - (NUM_FEATURES - 1) * inputSpacing) / 2;
        for (var i = 0; i < NUM_FEATURES; i++) inputY.push(inputStart + i * inputSpacing);

        var hiddenSpacing = Math.min(15, (svgH - 20) / hiddenCount);
        var hiddenStart = (svgH - (hiddenCount - 1) * hiddenSpacing) / 2;
        for (var i = 0; i < hiddenCount; i++) hiddenY.push(hiddenStart + i * hiddenSpacing);

        var outputSpacing = 40;
        var outputStart = (svgH - (NUM_ACTIONS - 1) * outputSpacing) / 2;
        for (var i = 0; i < NUM_ACTIONS; i++) outputY.push(outputStart + i * outputSpacing);

        // Find max weight magnitude for color scaling
        var maxW = 0.01;
        for (var i = 0; i < W1.length; i++) if (Math.abs(W1[i]) > maxW) maxW = Math.abs(W1[i]);
        for (var i = 0; i < W2.length; i++) if (Math.abs(W2[i]) > maxW) maxW = Math.abs(W2[i]);

        var svg = '<svg width="' + svgW + '" height="' + svgH +
            '" style="display:block;margin:0 auto;">';

        // Draw edges: input -> hidden (only strong connections)
        for (var h = 0; h < hiddenCount; h++) {
            for (var f = 0; f < NUM_FEATURES; f++) {
                var w = W1[h * NUM_FEATURES + f];
                var intensity = Math.abs(w) / maxW;
                if (intensity < 0.15) continue; // skip weak connections
                var color = w >= 0 ? '74,158,255' : '232,100,100';
                svg += '<line x1="' + (layerX[0] + 4) + '" y1="' + inputY[f] +
                    '" x2="' + (layerX[1] - 4) + '" y2="' + hiddenY[h] +
                    '" stroke="rgba(' + color + ',' + (intensity * 0.4).toFixed(2) +
                    ')" stroke-width="' + (0.5 + intensity * 1.5).toFixed(1) + '"/>';
            }
        }

        // Draw edges: hidden -> output
        for (var a = 0; a < NUM_ACTIONS; a++) {
            for (var h = 0; h < hiddenCount; h++) {
                var w = W2[a * NUM_HIDDEN + h];
                var intensity = Math.abs(w) / maxW;
                if (intensity < 0.1) continue;
                var color = w >= 0 ? '74,158,255' : '232,100,100';
                svg += '<line x1="' + (layerX[1] + 4) + '" y1="' + hiddenY[h] +
                    '" x2="' + (layerX[2] - 4) + '" y2="' + outputY[a] +
                    '" stroke="rgba(' + color + ',' + (intensity * 0.5).toFixed(2) +
                    ')" stroke-width="' + (0.5 + intensity * 2).toFixed(1) + '"/>';
            }
        }

        // Draw input nodes
        for (var i = 0; i < NUM_FEATURES; i++) {
            var act = inputAct ? Math.min(1, inputAct[i]) : 0;
            var fill = 'rgba(74,158,255,' + (0.15 + act * 0.7).toFixed(2) + ')';
            svg += '<circle cx="' + layerX[0] + '" cy="' + inputY[i] +
                '" r="4" fill="' + fill + '" stroke="#999" stroke-width="0.5"/>';
            svg += '<text x="' + (layerX[0] - 10) + '" y="' + (inputY[i] + 3) +
                '" text-anchor="end" font-size="9" fill="#86868b">' +
                inputLabels[i] + '</text>';
        }

        // Draw hidden nodes
        for (var i = 0; i < hiddenCount; i++) {
            var act = hiddenAct ? Math.min(1, hiddenAct[i] / 2) : 0;
            var fill = 'rgba(48,209,88,' + (0.15 + act * 0.7).toFixed(2) + ')';
            svg += '<circle cx="' + layerX[1] + '" cy="' + hiddenY[i] +
                '" r="4" fill="' + fill + '" stroke="#999" stroke-width="0.5"/>';
        }

        // Draw output nodes
        var outputColors = ['#86868b', '#4a9eff', '#ff9f0a'];
        for (var i = 0; i < NUM_ACTIONS; i++) {
            var isWinner = (i === winner);
            var act = outputAct ? outputAct[i] : 0;
            var r = isWinner ? 8 : 6;
            svg += '<circle cx="' + layerX[2] + '" cy="' + outputY[i] +
                '" r="' + r + '" fill="' + outputColors[i] +
                '" opacity="' + (0.3 + act * 0.7).toFixed(2) +
                '" stroke="' + (isWinner ? '#1d1d1f' : '#999') +
                '" stroke-width="' + (isWinner ? 2 : 0.5) + '"/>';
            var probText = outputAct ? (outputAct[i] * 100).toFixed(0) + '%' : '';
            svg += '<text x="' + (layerX[2] + 14) + '" y="' + (outputY[i] + 4) +
                '" font-size="11" font-weight="' + (isWinner ? '800' : '400') +
                '" fill="' + (isWinner ? '#1d1d1f' : '#86868b') + '">' +
                outputLabels[i] + (probText ? ' ' + probText : '') + '</text>';
        }

        // Layer labels
        svg += '<text x="' + layerX[0] + '" y="14" text-anchor="middle" font-size="10" fill="#86868b">Input (12)</text>';
        svg += '<text x="' + layerX[1] + '" y="14" text-anchor="middle" font-size="10" fill="#86868b">Hidden (16, ReLU)</text>';
        svg += '<text x="' + layerX[2] + '" y="14" text-anchor="middle" font-size="10" fill="#86868b">Output (3)</text>';

        svg += '</svg>';
        el.innerHTML = svg;
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
     * Train the MLP from sim AI gameplay data.
     */
    window.trainNNModel = function () {
        var runner = window.nnRunner;
        if (!runner) return;

        var statusEl = document.getElementById('nn-stats');
        var vizBox = document.getElementById('nn-viz-box');
        var playBtn = document.getElementById('nn-play-btn');
        if (playBtn) playBtn.style.display = 'none';
        if (vizBox) vizBox.style.display = 'none';

        // Stop any existing playback.
        runner.aiAgent = null;
        if (_statsInterval) { clearInterval(_statsInterval); _statsInterval = null; }
        _trained = false;
        _playing = false;

        // Initialize fresh weights.
        initWeights();

        function startTraining(dataset) {
            if (statusEl) statusEl.textContent = 'Training (epoch 0/150)...';
            if (vizBox) vizBox.style.display = 'block';

            // Render initial network diagram
            renderNetworkDiagram('nn-network-display', null);

            trainSGD(dataset, 150,
                function onProgress(epoch, lossHistory, acc) {
                    if (statusEl) statusEl.textContent =
                        'Training: epoch ' + epoch + '/150' +
                        ' | Loss: ' + lossHistory[lossHistory.length - 1].toFixed(4) +
                        ' | Accuracy: ' + (acc * 100).toFixed(1) + '%';
                    renderLossCurve('nn-loss-canvas', lossHistory);
                    renderNetworkDiagram('nn-network-display', null);
                },
                function onDone(lossHistory, acc) {
                    _trained = true;
                    if (statusEl) statusEl.textContent =
                        'Trained! Accuracy: ' + (acc * 100).toFixed(1) +
                        '% | 259 parameters | Loss: ' +
                        lossHistory[lossHistory.length - 1].toFixed(4);
                    renderLossCurve('nn-loss-canvas', lossHistory);
                    renderNetworkDiagram('nn-network-display', null);
                    if (playBtn) playBtn.style.display = '';
                });
        }

        // Fast path: use pre-saved gameplay data if available.
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
            startTraining(dataset);
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
                startTraining(dataset);
            });
    };

    /**
     * Toggle the trained MLP model playback.
     */
    window.playNNModel = function () {
        var runner = window.nnRunner;
        var playBtn = document.getElementById('nn-play-btn');

        // Toggle off if already playing
        if (_playing) {
            _playing = false;
            if (runner) runner.aiAgent = null;
            if (playBtn) playBtn.classList.remove('active');
            if (_statsInterval) { clearInterval(_statsInterval); _statsInterval = null; }
            return;
        }

        if (!_trained || !W1 || !runner) return;

        _playing = true;
        _deaths = 0;
        _bestScore = 0;
        if (playBtn) playBtn.classList.add('active');

        var statusEl = document.getElementById('nn-stats');

        var _frameCount = 0;
        var agent = {
            enabled: true,
            update: function (r) {
                if (!r.playing) return;
                var state = window.dinoShared.extractState(r);
                var probs = forwardPass(state);
                var action = argmax(probs);
                window.dinoShared.executeAction(action, r);
                // Animate network diagram every 6th frame (~10fps)
                _frameCount++;
                if (_frameCount % 6 === 0) {
                    renderNetworkDiagram('nn-network-display', state);
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
     * Stop MLP model playback.
     */
    window.stopNNModel = function () {
        _playing = false;
        var runner = window.nnRunner;
        if (runner) runner.aiAgent = null;
        if (_statsInterval) { clearInterval(_statsInterval); _statsInterval = null; }
        var playBtn = document.getElementById('nn-play-btn');
        if (playBtn) playBtn.classList.remove('active');
    };

})();
