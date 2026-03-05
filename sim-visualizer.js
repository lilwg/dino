// =============================================================================
// sim-visualizer.js — Visual explanation of the Sim AI's decision process.
//
// Draws labeled trails showing each simulated future (jump, duck, run) as
// dotted paths spreading rightward from the dino. Each trail is labeled at
// the START ("IF JUMP") and END ("✓ 24px" or "✗ HIT") so you can see
// exactly what the AI considered and why it chose what it did.
//
// Per-frame colouring (chosen trail only):
//   - Red (#ff3b30)         → collision (clearance < 0)
//   - Yellow (#ffcc00)      → very close (clearance 0–4)
//   - Light green (#8ee53f) → moderate (clearance 4–8)
//   - Bright green (#30d158)→ safe (clearance ≥ 8)
//
// Unchosen trails use a fixed per-action colour (blue/orange/grey).
// The chosen trail is brighter with a connecting line and outcome badge.
//
// Also draws:
//   - Faint dashed obstacle outlines so you can see what's being avoided
//   - Compound transition markers ("→ duck") when a jump chains a follow-up
//   - Reaction window line (orange dashed vertical)
//
// Depends on: Runner, Trex, window._simAgent._vizData (from ai-agent.js).
// =============================================================================
(function () {
    'use strict';

    // Clearance thresholds for per-frame colour gradient.
    var THRESHOLD_SAFE = 8;
    var THRESHOLD_MODERATE = 4;

    // Trail colours.
    var COL_SAFE     = '#30d158';   // bright green — plenty of room
    var COL_MODERATE = '#8ee53f';   // light green  — decent room
    var COL_CLOSE    = '#ffcc00';   // yellow       — tight squeeze
    var COL_DANGER   = '#ff3b30';   // red          — collision / death

    // Trail colours for labelling (per-action, visually distinct).
    var LABEL_COLORS = {
        jump: '#0071e3',  // blue
        duck: '#ff9f0a',  // orange
        run:  '#8e8e93'   // grey
    };

    // Obstacle outline colour.
    var COL_OBSTACLE = '#8e8e93';

    /**
     * Per-frame clearance → hex colour.
     */
    function clearanceColor(clearance) {
        if (clearance < 0)                return COL_DANGER;
        if (clearance < THRESHOLD_MODERATE) return COL_CLOSE;
        if (clearance < THRESHOLD_SAFE)   return COL_MODERATE;
        return COL_SAFE;
    }

    /**
     * Invert a hex colour for night-mode compensation.
     */
    function invertColor(hex) {
        var r = parseInt(hex.slice(1, 3), 16);
        var g = parseInt(hex.slice(3, 5), 16);
        var b = parseInt(hex.slice(5, 7), 16);
        return '#' +
            ('0' + (255 - r).toString(16)).slice(-2) +
            ('0' + (255 - g).toString(16)).slice(-2) +
            ('0' + (255 - b).toString(16)).slice(-2);
    }

    // Night-mode state — set once per draw() call from runner.inverted.
    var _inverted = false;

    /**
     * Pre-invert colour during night mode so the CSS filter: invert(100%)
     * on .game-wrapper cancels it back to the original colour.
     * This keeps trail colours stable across day/night transitions.
     */
    function nightAdjust(color) {
        return _inverted ? invertColor(color) : color;
    }

    // =========================================================================
    // SimVisualizer
    // =========================================================================

    function SimVisualizer() {
        this.enabled = false;
    }

    /**
     * Main draw call — called from window._postRenderHook.
     */
    SimVisualizer.prototype.draw = function (ctx, runner) {
        if (!this.enabled) return;

        // Sync night-mode flag so nightAdjust() pre-inverts colours.
        _inverted = !!(runner && runner.inverted);

        var agent = window._simAgent;
        if (!agent || !agent._vizData) return;

        var viz = agent._vizData;
        var speed = Math.floor(viz.speed);

        ctx.save();

        // Draw obstacle outlines first (background layer).
        this._drawObstacles(ctx, viz);

        // Trail data.
        var actions = ['jump', 'duck', 'run'];
        var trailData = {
            jump: viz.jumpArc,
            duck: viz.duckPositions,
            run:  viz.runPositions
        };

        // Draw non-chosen trails first, then chosen trail on top.
        for (var pass = 0; pass < 2; pass++) {
            for (var a = 0; a < actions.length; a++) {
                var action = actions[a];
                var isChosen = (viz.chosenAction === action);
                if ((pass === 0 && isChosen) || (pass === 1 && !isChosen)) continue;

                var frames = trailData[action];
                if (!frames || frames.length === 0) continue;

                var alpha = isChosen ? 0.7 : 0.45;
                var clearanceData = viz.clearances[action] || { minClearance: 9999, collisionFrame: -1 };

                // Remap to verb forms for labels.
                var displayAction;
                if (viz.midJump && action === 'duck') {
                    displayAction = 'dropping';
                } else if (action === 'jump') {
                    displayAction = 'jumping';
                } else if (action === 'duck') {
                    displayAction = 'ducking';
                } else {
                    displayAction = 'running';
                }

                this._drawTrail(ctx, frames, speed, action, alpha, isChosen, displayAction, clearanceData);
            }
        }

        // Draw prominent decision badge showing what the AI chose.
        this._drawDecisionBadge(ctx, viz);

        // (Reaction window line removed — not needed.)

        ctx.restore();
    };

    // -------------------------------------------------------------------------
    // Obstacle outlines — faint dashed rectangles
    // -------------------------------------------------------------------------

    SimVisualizer.prototype._drawObstacles = function (ctx, viz) {
        if (!viz.obstacles) return;

        ctx.save();
        ctx.globalAlpha = 0.2;
        ctx.strokeStyle = nightAdjust(COL_OBSTACLE);
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;

        for (var i = 0; i < viz.obstacles.length; i++) {
            var obs = viz.obstacles[i];
            ctx.strokeRect(obs.xPos, obs.yPos, obs.width, obs.height);
        }

        ctx.setLineDash([]);
        ctx.restore();
    };

    // -------------------------------------------------------------------------
    // Decision badge — prominent label showing what the AI chose
    // -------------------------------------------------------------------------

    SimVisualizer.prototype._drawDecisionBadge = function (ctx, viz) {
        var chosenAction = viz.chosenAction;

        // Map to display name.
        var displayName;
        if (viz.midJump && chosenAction === 'duck') {
            displayName = 'DROPPING';
        } else if (chosenAction === 'jump') {
            displayName = 'JUMPING';
        } else if (chosenAction === 'duck') {
            displayName = 'DUCKING';
        } else {
            displayName = 'RUNNING';
        }

        // Map to action colour.
        var colorKey = chosenAction;
        var actionColor = LABEL_COLORS[colorKey] || '#8e8e93';

        // Get clearance for the chosen action.
        var clearData = viz.clearances[chosenAction] || { minClearance: 9999, collisionFrame: -1 };
        var safe = clearData.collisionFrame < 0 && clearData.minClearance >= 0;

        var text = '→ ' + displayName;
        if (safe && clearData.minClearance < 9999) {
            if (clearData.minClearance > 100) {
                text += '  ✓';
            } else {
                text += '  ✓ ' + Math.round(clearData.minClearance) + 'px';
            }
        } else if (!safe) {
            text += '  ✗';
        }

        // Draw near the dino, above it.
        var badgeX = viz.tRexPos.x + 2;
        var badgeY = 12;

        ctx.save();
        ctx.font = 'bold 11px sans-serif';
        ctx.textBaseline = 'middle';

        var metrics = ctx.measureText(text);
        var padX = 5, padY = 7;

        // Background pill.
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = nightAdjust(actionColor);
        var r = 4;
        var bx = badgeX - padX;
        var by = badgeY - padY;
        var bw = metrics.width + padX * 2;
        var bh = padY * 2;
        ctx.beginPath();
        ctx.moveTo(bx + r, by);
        ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
        ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
        ctx.arcTo(bx, by + bh, bx, by, r);
        ctx.arcTo(bx, by, bx + bw, by, r);
        ctx.fill();

        // Text.
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = nightAdjust(actionColor);
        ctx.fillText(text, badgeX, badgeY);

        ctx.restore();
    };

    // -------------------------------------------------------------------------
    // Trail — dotted path with start label, outcome badge, transition markers
    // -------------------------------------------------------------------------

    SimVisualizer.prototype._drawTrail = function (ctx, frames, speed, action, alpha, isChosen, displayAction, clearanceData) {
        if (frames.length === 0) return;

        var canvasWidth = ctx.canvas.width;
        if (window.devicePixelRatio > 1) canvasWidth /= 2; // HDPI scaling

        var baseX = frames[0].x;
        var dotRadius = isChosen ? 3 : 2.5;

        // Determine the per-action colour for unchosen trails.
        var colorKey = action;
        var actionColor = LABEL_COLORS[colorKey] || '#8e8e93';

        // Track last drawn position for the outcome badge.
        var lastDrawX = baseX, lastDrawY = frames[0].y;
        var lastDucking = frames[0].ducking;

        // Track previous frame state for transition detection.
        var prevJumping = frames[0].jumping;
        var prevDucking = frames[0].ducking;
        // Track whether we've already drawn a transition marker (only draw first one).
        var transitionDrawn = false;

        // --- Draw dots ---
        for (var i = 0; i < frames.length; i++) {
            var f = frames[i];
            var drawX = baseX + i * speed;
            var drawY = f.y;

            // Small vertical offset for duck trail so it doesn't overlap run.
            if (action === 'duck' && !f.jumping) {
                drawY += 4;
            }

            if (drawX > canvasWidth + 10) break;

            lastDrawX = drawX;
            lastDrawY = drawY;
            lastDucking = f.ducking;

            // All trails use the per-action colour so labels and dots match.
            var color = actionColor;

            this._drawDot(ctx, drawX, drawY, dotRadius, color, alpha, f.ducking);

            // --- Detect compound transitions (chosen trail only, first transition) ---
            if (isChosen && i > 0 && !transitionDrawn) {
                var landed = prevJumping && !f.jumping;
                var startedDuck = !prevDucking && f.ducking && !f.jumping;

                if (landed) {
                    transitionDrawn = true;
                    if (f.ducking) {
                        this._drawTransitionMarker(ctx, drawX, drawY, 'duck', alpha, f.ducking);
                    } else if (f.jumping) {
                        this._drawTransitionMarker(ctx, drawX, drawY, 'jump', alpha, false);
                    } else {
                        this._drawTransitionMarker(ctx, drawX, drawY, 'run', alpha, false);
                    }
                }
                // Duck-to-something transition (first obstacle passed during duck action).
                if (action === 'duck' && prevDucking && !f.ducking) {
                    transitionDrawn = true;
                    if (f.jumping) {
                        this._drawTransitionMarker(ctx, drawX, drawY, 'jump', alpha, false);
                    } else {
                        this._drawTransitionMarker(ctx, drawX, drawY, 'run', alpha, false);
                    }
                }
            }

            prevJumping = f.jumping;
            prevDucking = f.ducking;
        }

        // --- Connecting line for chosen trail ---
        if (isChosen && frames.length > 1) {
            this._drawConnectingLine(ctx, frames, baseX, speed, alpha * 0.3, canvasWidth, action, actionColor);
        }

        // Start labels removed — the decision badge at the top is sufficient.

        // --- Outcome badge at end ---
        var endX = lastDrawX + (lastDucking ? 42 : 34);
        var endY = lastDrawY + (lastDucking ? 20 : 22);
        if (action === 'duck' && !lastDucking) endY += 4;
        this._drawOutcomeBadge(ctx, endX, endY, clearanceData, isChosen, alpha, actionColor);
    };

    // -------------------------------------------------------------------------
    // Dot — small coloured circle
    // -------------------------------------------------------------------------

    SimVisualizer.prototype._drawDot = function (ctx, x, y, radius, color, alpha, isDucking) {
        var c = nightAdjust(color);

        var dotX = x + (isDucking ? 30 : 22);
        var dotY = y + (isDucking ? 20 : 22);

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(dotX, dotY, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    };

    // -------------------------------------------------------------------------
    // Connecting line — thin line joining dots for the chosen trail
    // -------------------------------------------------------------------------

    SimVisualizer.prototype._drawConnectingLine = function (ctx, frames, baseX, speed, alpha, canvasWidth, action, actionColor) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = nightAdjust(actionColor);

        ctx.beginPath();
        var started = false;

        for (var i = 0; i < frames.length; i++) {
            var f = frames[i];
            var drawX = baseX + i * speed;
            if (drawX > canvasWidth + 10) break;

            var cx = drawX + (f.ducking ? 30 : 22);
            var cy = f.y + (f.ducking ? 20 : 22);

            if (action === 'duck' && !f.jumping) {
                cy += 4;
            }

            if (!started) {
                ctx.moveTo(cx, cy);
                started = true;
            } else {
                ctx.lineTo(cx, cy);
            }
        }

        ctx.stroke();
        ctx.restore();
    };

    // (Start labels removed — decision badge at top is sufficient.)

    // -------------------------------------------------------------------------
    // Outcome badge — "✓ 24px" or "✗ HIT" at the end of a trail
    // -------------------------------------------------------------------------

    SimVisualizer.prototype._drawOutcomeBadge = function (ctx, x, y, clearanceData, isChosen, alpha, actionColor) {
        var minClear = clearanceData.minClearance;
        var collided = clearanceData.collisionFrame >= 0;

        // Skip badges when clearance is at the absolute max (no obstacle existed).
        if (minClear >= 9999 && !collided) return;

        var text, color;
        if (collided || minClear < 0) {
            text = '✗ HIT';
            color = COL_DANGER;
        } else if (minClear > 100) {
            // Very high clearance = obstacle easily cleared (over/under).
            text = '✓ SAFE';
            color = COL_SAFE;
        } else {
            var px = Math.round(minClear);
            text = '✓ ' + px + 'px';
            color = minClear >= THRESHOLD_SAFE ? COL_SAFE :
                    minClear >= THRESHOLD_MODERATE ? COL_MODERATE : COL_CLOSE;
        }

        if (isChosen) {
            text += ' ◀';
        }

        // Get canvas width for clipping.
        var canvasWidth = ctx.canvas.width;
        if (window.devicePixelRatio > 1) canvasWidth /= 2; // HDPI scaling

        ctx.save();
        ctx.font = (isChosen ? 'bold ' : '') + '9px sans-serif';
        ctx.textBaseline = 'middle';

        // If badge would extend past canvas edge, right-align it.
        var metrics = ctx.measureText(text);
        var drawX = x;
        if (drawX + metrics.width > canvasWidth - 4) {
            drawX = canvasWidth - metrics.width - 4;
        }

        // Subtle background pill for readability.
        var padX = 3, padY = 5;

        var bgAlpha = isChosen ? 0.15 : 0.08;
        ctx.globalAlpha = bgAlpha;
        ctx.fillStyle = nightAdjust(color);
        var r = 3;
        var bx = drawX - padX;
        var by = y - padY;
        var bw = metrics.width + padX * 2;
        var bh = padY * 2;
        ctx.beginPath();
        ctx.moveTo(bx + r, by);
        ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
        ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
        ctx.arcTo(bx, by + bh, bx, by, r);
        ctx.arcTo(bx, by, bx + bw, by, r);
        ctx.fill();

        // Text on top.
        ctx.globalAlpha = isChosen ? 0.85 : 0.6;
        ctx.fillStyle = nightAdjust(color);
        ctx.fillText(text, drawX, y);

        ctx.restore();
    };

    // -------------------------------------------------------------------------
    // Transition marker — "→ duck" at compound action boundaries
    // -------------------------------------------------------------------------

    SimVisualizer.prototype._drawTransitionMarker = function (ctx, x, y, nextAction, alpha, isDucking) {
        var text = '→ ' + nextAction;
        var markerX = x + (isDucking ? 30 : 22);
        var markerY = y + (isDucking ? 12 : 14);

        ctx.save();
        ctx.globalAlpha = alpha * 0.8;
        ctx.font = 'bold 8px sans-serif';
        ctx.fillStyle = nightAdjust(LABEL_COLORS[nextAction] || '#8e8e93');
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(text, markerX, markerY);
        ctx.restore();
    };

    // (Reaction window line removed.)

    // =========================================================================
    // Expose
    // =========================================================================

    window.SimVisualizer = SimVisualizer;
    window._simVisualizer = new SimVisualizer();

})();
