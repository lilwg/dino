// =============================================================================
// Decision Tree Agent — CART classifier for Chrome Dino game.
//
// Trains a decision tree from gameplay data collected by watching the sim AI.
// The tree is fully interpretable: each node is an if/else on a single feature.
// Compact vertical diagram with live decision-path animation during play.
//
// Depends on: window.dinoShared (extractState, executeAction) from rl-agent.js
//             AIAgent (from ai-agent.js) for data collection
// =============================================================================
(function () {
    'use strict';

    var NUM_ACTIONS = 3; // 0=run, 1=jump, 2=duck
    var ACTION_NAMES = ['RUN', 'JUMP', 'DUCK'];
    var FEATURE_NAMES = [
        'dist\u2081', 'ptero\u2081', 'yPos\u2081', 'width\u2081',
        'dist\u2082', 'ptero\u2082', 'yPos\u2082',
        'speed', 'jumpH', 'jumping', 'ducking', 'height\u2081'
    ];

    var MAX_DEPTH = 8;
    var DISPLAY_DEPTH = 4;
    var TARGET_FRAMES = 6000;

    // -----------------------------------------------------------------------
    // CART tree builder (Gini impurity)
    // -----------------------------------------------------------------------

    function gini(data) {
        if (data.length === 0) return 0;
        var counts = new Float64Array(NUM_ACTIONS);
        for (var i = 0; i < data.length; i++) counts[data[i].label]++;
        var sum = 0;
        for (var c = 0; c < NUM_ACTIONS; c++) {
            var p = counts[c] / data.length;
            sum += p * p;
        }
        return 1 - sum;
    }

    function majorityLabel(data) {
        var counts = new Float64Array(NUM_ACTIONS);
        for (var i = 0; i < data.length; i++) counts[data[i].label]++;
        var best = 0;
        for (var c = 1; c < NUM_ACTIONS; c++) {
            if (counts[c] > counts[best]) best = c;
        }
        return best;
    }

    function buildTree(data, depth) {
        if (data.length === 0) return { label: 0, count: 0 };
        if (depth >= MAX_DEPTH || gini(data) === 0) {
            return { label: majorityLabel(data), count: data.length };
        }

        var nFeatures = data[0].input.length;
        var bestGini = Infinity;
        var bestFeature = -1;
        var bestThreshold = 0;

        for (var f = 0; f < nFeatures; f++) {
            var vals = [];
            for (var i = 0; i < data.length; i++) vals.push(data[i].input[f]);
            vals.sort(function (a, b) { return a - b; });

            var step = Math.max(1, Math.floor(vals.length / 50));
            for (var i = 0; i < vals.length - 1; i += step) {
                if (vals[i] === vals[i + 1]) continue;
                var threshold = (vals[i] + vals[i + 1]) / 2;

                var leftCount = new Float64Array(NUM_ACTIONS);
                var rightCount = new Float64Array(NUM_ACTIONS);
                var nLeft = 0, nRight = 0;
                for (var j = 0; j < data.length; j++) {
                    if (data[j].input[f] <= threshold) {
                        leftCount[data[j].label]++;
                        nLeft++;
                    } else {
                        rightCount[data[j].label]++;
                        nRight++;
                    }
                }
                if (nLeft === 0 || nRight === 0) continue;

                var gLeft = 1, gRight = 1;
                for (var c = 0; c < NUM_ACTIONS; c++) {
                    var pL = leftCount[c] / nLeft;
                    gLeft -= pL * pL;
                    var pR = rightCount[c] / nRight;
                    gRight -= pR * pR;
                }
                var wGini = (nLeft * gLeft + nRight * gRight) / data.length;

                if (wGini < bestGini) {
                    bestGini = wGini;
                    bestFeature = f;
                    bestThreshold = threshold;
                }
            }
        }

        if (bestFeature < 0) {
            return { label: majorityLabel(data), count: data.length };
        }

        var leftData = [], rightData = [];
        for (var j = 0; j < data.length; j++) {
            if (data[j].input[bestFeature] <= bestThreshold) {
                leftData.push(data[j]);
            } else {
                rightData.push(data[j]);
            }
        }

        return {
            feature: bestFeature,
            threshold: bestThreshold,
            left: buildTree(leftData, depth + 1),
            right: buildTree(rightData, depth + 1),
            count: data.length
        };
    }

    // -----------------------------------------------------------------------
    // Class balancing — undersample majority class (RUN) to fix bias
    // -----------------------------------------------------------------------

    function balanceDataset(dataset) {
        var buckets = [[], [], []];
        for (var i = 0; i < dataset.length; i++) {
            buckets[dataset[i].label].push(dataset[i]);
        }

        var minCount = Infinity;
        for (var c = 0; c < NUM_ACTIONS; c++) {
            if (buckets[c].length > 0 && buckets[c].length < minCount) {
                minCount = buckets[c].length;
            }
        }
        if (minCount === 0 || minCount === Infinity) return dataset;

        var cap = minCount * 3;
        var balanced = [];
        for (var c = 0; c < NUM_ACTIONS; c++) {
            var b = buckets[c];
            for (var i = b.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var tmp = b[i]; b[i] = b[j]; b[j] = tmp;
            }
            var take = Math.min(b.length, cap);
            for (var i = 0; i < take; i++) {
                balanced.push(b[i]);
            }
        }
        return balanced;
    }

    // -----------------------------------------------------------------------
    // Tree inference
    // -----------------------------------------------------------------------

    function predict(node, state) {
        if (node.label !== undefined) return node.label;
        if (state[node.feature] <= node.threshold) {
            return predict(node.left, state);
        } else {
            return predict(node.right, state);
        }
    }

    /**
     * Predict and return the path of node IDs traversed.
     * Requires nodes to have ._id set during rendering.
     */
    function predictWithPath(node, state) {
        var path = [];
        var cur = node;
        while (cur) {
            if (cur._id !== undefined) path.push(cur._id);
            if (cur.label !== undefined) break;
            if (state[cur.feature] <= cur.threshold) {
                cur = cur.left;
            } else {
                cur = cur.right;
            }
        }
        return path;
    }

    // -----------------------------------------------------------------------
    // Tree visualization — compact vertical indented tree
    // -----------------------------------------------------------------------

    var ACTION_CLASSES = ['tg-run', 'tg-jump', 'tg-duck'];
    var _nextNodeId = 0;

    /**
     * Get the majority action of a subtree (for collapsed nodes).
     */
    function getSubtreeMajority(node) {
        if (node.label !== undefined) return node.label;
        var counts = new Float64Array(NUM_ACTIONS);
        countLeafActions(node, counts);
        var best = 0;
        for (var c = 1; c < NUM_ACTIONS; c++) {
            if (counts[c] > counts[best]) best = c;
        }
        return best;
    }

    function countLeafActions(node, counts) {
        if (node.label !== undefined) {
            counts[node.label] += (node.count || 1);
            return;
        }
        countLeafActions(node.left, counts);
        countLeafActions(node.right, counts);
    }

    // -----------------------------------------------------------------------
    // Graphical tree layout — pill-shaped nodes with SVG connecting lines
    // -----------------------------------------------------------------------

    var _nodePositions = {}; // nid → {x, y, w, h}

    /**
     * Assign unique IDs and compute subtree widths for layout.
     * Returns {w: total width, h: total height, node: node}.
     */
    function layoutTree(node, depth) {
        if (depth === undefined) { depth = 0; _nextNodeId = 0; }
        var id = _nextNodeId++;
        node._id = id;

        var NODE_H = 26;    // node height
        var GAP_X = 4;      // horizontal gap between siblings
        var GAP_Y = 28;     // vertical gap between levels

        // Estimate node text width.
        var label;
        if (node.label !== undefined) {
            label = ACTION_NAMES[node.label];
        } else if (depth >= DISPLAY_DEPTH) {
            label = ACTION_NAMES[getSubtreeMajority(node)];
        } else {
            var fn = FEATURE_NAMES[node.feature] || ('f' + node.feature);
            label = fn + ' \u2264 ' + node.threshold.toFixed(2);
        }
        var textW = label.length * 6.5 + 16; // rough char width + padding
        var nodeW = Math.max(textW, 44);

        // Leaf or collapsed — just the node itself.
        if (node.label !== undefined || depth >= DISPLAY_DEPTH) {
            return { w: nodeW, h: NODE_H, nodeW: nodeW, nodeH: NODE_H,
                     id: id, node: node, depth: depth, label: label,
                     isLeaf: true };
        }

        // Internal: layout children recursively.
        var left = layoutTree(node.left, depth + 1);
        var right = layoutTree(node.right, depth + 1);

        var childrenW = left.w + GAP_X + right.w;
        var totalW = Math.max(nodeW, childrenW);
        var totalH = NODE_H + GAP_Y + Math.max(left.h, right.h);

        return { w: totalW, h: totalH, nodeW: nodeW, nodeH: NODE_H,
                 id: id, node: node, depth: depth, label: label,
                 isLeaf: false, left: left, right: right,
                 childrenW: childrenW };
    }

    /**
     * Render the laid-out tree as positioned HTML nodes + SVG lines.
     * @param {Object} layout Output from layoutTree.
     * @returns {string} HTML string.
     */
    function treeToGraphHTML(node) {
        var layout = layoutTree(node, 0);

        var GAP_Y = 28;
        var GAP_X = 4;
        var NODE_H = 26;
        var nodes = [];
        var lines = [];

        // Recursively assign positions and collect nodes/lines.
        function place(lay, cx, y) {
            // cx = center X of this subtree's allocation
            _nodePositions[lay.id] = { x: cx - lay.nodeW / 2, y: y,
                                        w: lay.nodeW, h: lay.nodeH };

            var isLeaf = lay.isLeaf;
            var cls = '';
            var labelHtml = '';
            if (lay.node.label !== undefined) {
                cls = 'tv-leaf ' + ACTION_CLASSES[lay.node.label];
                labelHtml = lay.label;
            } else if (lay.depth >= DISPLAY_DEPTH) {
                var action = getSubtreeMajority(lay.node);
                cls = 'tv-leaf ' + ACTION_CLASSES[action];
                labelHtml = lay.label;
            } else {
                cls = 'tv-cond';
                labelHtml = lay.label;
            }

            nodes.push({ id: lay.id, x: cx - lay.nodeW / 2, y: y,
                          w: lay.nodeW, h: NODE_H, cls: cls,
                          label: labelHtml });

            if (!isLeaf) {
                var childY = y + NODE_H + GAP_Y;
                var childrenW = lay.left.w + GAP_X + lay.right.w;
                var leftCX = cx - childrenW / 2 + lay.left.w / 2;
                var rightCX = cx + childrenW / 2 - lay.right.w / 2;

                // Connecting lines from parent center-bottom to child center-top.
                lines.push({ x1: cx, y1: y + NODE_H,
                             x2: leftCX, y2: childY,
                             from: lay.id, to: lay.left.id });
                lines.push({ x1: cx, y1: y + NODE_H,
                             x2: rightCX, y2: childY,
                             from: lay.id, to: lay.right.id });

                place(lay.left, leftCX, childY);
                place(lay.right, rightCX, childY);
            }
        }

        place(layout, layout.w / 2, 0);

        // Build HTML.  Wrap in an outer scaler that shrinks if needed.
        var totalW = layout.w;
        var totalH = layout.h;
        var html = '<div class="tv-graph-wrap" data-tree-w="' + totalW +
            '" data-tree-h="' + totalH + '">' +
            '<div class="tv-graph" style="width:' + totalW +
            'px;height:' + totalH + 'px;position:relative;">';

        // SVG for lines.
        html += '<svg class="tv-lines" width="' + totalW + '" height="' +
            totalH + '" style="position:absolute;top:0;left:0;">';
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            // Curved line: cubic bezier from parent bottom to child top.
            var midY = l.y1 + (l.y2 - l.y1) * 0.5;
            html += '<path class="tv-line" data-from="' + l.from +
                '" data-to="' + l.to +
                '" d="M' + l.x1 + ',' + l.y1 +
                ' C' + l.x1 + ',' + midY + ' ' + l.x2 + ',' + midY +
                ' ' + l.x2 + ',' + l.y2 + '" />';
        }
        html += '</svg>';

        // Nodes.
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            html += '<div class="tv-node ' + n.cls + '" data-nid="' + n.id +
                '" style="left:' + n.x + 'px;top:' + n.y + 'px;width:' +
                n.w + 'px;height:' + n.h + 'px;">' + n.label + '</div>';
        }

        html += '</div></div>';
        return html;
    }

    /**
     * After inserting treeToGraphHTML into the DOM, call this to auto-scale
     * the tree so it fits within its parent container.
     */
    function fitTreeToContainer() {
        var wrap = document.querySelector('.tv-graph-wrap');
        if (!wrap) return;
        var treeW = parseInt(wrap.getAttribute('data-tree-w'), 10);
        var treeH = parseInt(wrap.getAttribute('data-tree-h'), 10);
        var parentW = wrap.parentElement.clientWidth - 32; // account for padding
        if (treeW > parentW && parentW > 0) {
            var scale = parentW / treeW;
            wrap.style.height = Math.ceil(treeH * scale) + 'px';
            var graph = wrap.querySelector('.tv-graph');
            graph.style.transformOrigin = 'top left';
            graph.style.transform = 'scale(' + scale.toFixed(4) + ')';
        } else {
            wrap.style.height = treeH + 'px';
        }
    }

    function accuracy(tree, data) {
        var correct = 0;
        for (var i = 0; i < data.length; i++) {
            if (predict(tree, data[i].input) === data[i].label) correct++;
        }
        return correct / data.length;
    }

    function usedFeatures(node, set) {
        if (!set) set = {};
        if (node.label !== undefined) return set;
        set[node.feature] = true;
        usedFeatures(node.left, set);
        usedFeatures(node.right, set);
        return set;
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
            onCrash: function (r) {
                simAgent.onCrash(r);
            },
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
    // Stored state
    // -----------------------------------------------------------------------
    var _tree = null;
    var _dataset = null;
    var _playing = false;
    var _deaths = 0;
    var _bestScore = 0;
    var _statsInterval = null;
    var _lastHighlightedPath = [];

    // -----------------------------------------------------------------------
    // Live path animation
    // -----------------------------------------------------------------------

    function highlightPath(path) {
        // Clear previous highlights.
        for (var i = 0; i < _lastHighlightedPath.length; i++) {
            var old = document.querySelector('.tv-node[data-nid="' + _lastHighlightedPath[i] + '"]');
            if (old) old.classList.remove('tv-active');
        }
        var oldLines = document.querySelectorAll('.tv-line.tv-line-active');
        for (var i = 0; i < oldLines.length; i++) {
            oldLines[i].classList.remove('tv-line-active');
        }
        // Highlight nodes on the path.
        for (var i = 0; i < path.length; i++) {
            var el = document.querySelector('.tv-node[data-nid="' + path[i] + '"]');
            if (el) el.classList.add('tv-active');
        }
        // Highlight connecting lines between consecutive path nodes.
        for (var i = 0; i < path.length - 1; i++) {
            var line = document.querySelector(
                '.tv-line[data-from="' + path[i] + '"][data-to="' + path[i + 1] + '"]');
            if (line) line.classList.add('tv-line-active');
        }
        _lastHighlightedPath = path;
    }

    function clearHighlight() {
        for (var i = 0; i < _lastHighlightedPath.length; i++) {
            var old = document.querySelector('.tv-node[data-nid="' + _lastHighlightedPath[i] + '"]');
            if (old) old.classList.remove('tv-active');
        }
        var oldLines = document.querySelectorAll('.tv-line.tv-line-active');
        for (var i = 0; i < oldLines.length; i++) {
            oldLines[i].classList.remove('tv-line-active');
        }
        _lastHighlightedPath = [];
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    window.trainDecisionTree = function () {
        var runner = window.dtreeRunner;
        if (!runner) return;

        var statusEl = document.getElementById('dtree-stats');
        var treeEl = document.getElementById('dtree-output');
        var vizBox = document.getElementById('dtree-viz-box');
        var playBtn = document.getElementById('dtree-play-btn');
        if (playBtn) { playBtn.style.display = 'none'; playBtn.classList.remove('active'); }
        if (vizBox) vizBox.style.display = 'none';
        if (treeEl) { treeEl.innerHTML = ''; }

        // Stop any existing playback.
        _playing = false;
        runner.aiAgent = null;
        if (_statsInterval) { clearInterval(_statsInterval); _statsInterval = null; }

        function buildAndShow(dataset) {
            _dataset = dataset;

            var balanced = balanceDataset(dataset);

            if (statusEl) statusEl.textContent =
                'Building tree from ' + balanced.length + ' balanced samples (' + dataset.length + ' raw)...';

            setTimeout(function () {
                _tree = buildTree(balanced, 0);

                var acc = accuracy(_tree, dataset);
                var features = usedFeatures(_tree);
                var featureList = [];
                for (var f in features) {
                    featureList.push(FEATURE_NAMES[f] || ('f' + f));
                }

                if (statusEl) {
                    statusEl.textContent =
                        'Accuracy: ' + (acc * 100).toFixed(1) + '% on ' +
                        dataset.length + ' frames | Features: ' +
                        featureList.join(', ');
                }

                if (vizBox) vizBox.style.display = 'block';
                if (treeEl) {
                    treeEl.innerHTML = '<div class="tv-wrap">' +
                        treeToGraphHTML(_tree) + '</div>';
                    fitTreeToContainer();
                }

                if (playBtn) playBtn.style.display = '';
            }, 50);
        }

        // Fast path: use pre-saved multi-speed gameplay data if available.
        // Labels from the teacher network (much more balanced than transition-based labels)
        if (window.PRESAVED_GAMEPLAY) {
            if (statusEl) statusEl.textContent = 'Building tree from ' +
                window.PRESAVED_GAMEPLAY.length + ' pre-saved frames...';
            var dataset = [];
            var samples = window.PRESAVED_GAMEPLAY;
            var teacher = window._precomputedTeacher ? window._precomputedTeacher.net : null;
            var useTeacher = teacher && window.forwardWithActivations;
            for (var i = 0; i < samples.length; i++) {
                var s = samples[i];
                var input = new Float64Array(s.slice(0, 12));
                var label;
                if (useTeacher) {
                    var acts = window.forwardWithActivations(input, teacher);
                    var out = acts[acts.length - 1];
                    label = 0;
                    for (var a = 1; a < NUM_ACTIONS; a++) {
                        if (out[a] > out[label]) label = a;
                    }
                } else {
                    label = s[12];
                }
                dataset.push({ input: input, label: label });
            }
            buildAndShow(dataset);
            return;
        }

        // Fallback: live data collection.
        if (statusEl) statusEl.textContent = 'Collecting sim AI gameplay data...';

        collectSimData(runner, TARGET_FRAMES,
            function onProgress(n, total) {
                if (statusEl) statusEl.textContent =
                    'Collecting data: ' + n + ' / ' + total + ' frames';
            },
            function onDone(dataset) {
                buildAndShow(dataset);
            });
    };

    /**
     * Toggle the trained decision tree as an AI agent.
     */
    window.playDecisionTree = function () {
        var runner = window.dtreeRunner;
        var playBtn = document.getElementById('dtree-play-btn');

        // Toggle off if already playing
        if (_playing) {
            _playing = false;
            if (runner) runner.aiAgent = null;
            if (playBtn) playBtn.classList.remove('active');
            if (_statsInterval) { clearInterval(_statsInterval); _statsInterval = null; }
            clearHighlight();
            return;
        }

        if (!_tree || !runner) return;

        _playing = true;
        _deaths = 0;
        _bestScore = 0;
        if (playBtn) playBtn.classList.add('active');

        var statusEl = document.getElementById('dtree-stats');
        var _frameCount = 0;

        var agent = {
            enabled: true,
            update: function (r) {
                if (!r.playing) return;
                var state = window.dinoShared.extractState(r);
                var action = predict(_tree, state);
                window.dinoShared.executeAction(action, r);

                // Animate path every 6th frame (~10fps) to avoid DOM thrashing
                _frameCount++;
                if (_frameCount % 6 === 0) {
                    var path = predictWithPath(_tree, state);
                    highlightPath(path);
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

    window.stopDecisionTree = function () {
        _playing = false;
        var runner = window.dtreeRunner;
        if (runner) runner.aiAgent = null;
        if (_statsInterval) { clearInterval(_statsInterval); _statsInterval = null; }
        var playBtn = document.getElementById('dtree-play-btn');
        if (playBtn) playBtn.classList.remove('active');
        clearHighlight();
    };

})();
