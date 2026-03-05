// =============================================================================
// ghost-trex.js — Lightweight physics-only T-Rex clones for parallel RL eval.
//
// Each GhostTrex mirrors the physics of the real Trex (startJump, updateJump,
// setSpeedDrop, setDuck) but carries no canvas/animation state.  50 of them
// run simultaneously on the same obstacle field. The draw() method renders
// them as colour-tinted semi-transparent sprites on the shared game canvas.
//
// Depends on: Runner, Trex, CollisionBox, boxCompare, createAdjustedCollisionBox
// (all exposed on window by index.js).
// =============================================================================
(function () {
    'use strict';

    var Trex  = window.Trex;
    var CollisionBox = window.CollisionBox;
    var boxCompare = window.boxCompare;
    var createAdjustedCollisionBox = window.createAdjustedCollisionBox;

    // Canvas ground Y (same formula as Trex.init).
    var GROUND_Y = Runner.defaultDimensions.HEIGHT - Trex.config.HEIGHT -
        Runner.config.BOTTOM_PAD;  // 150 - 47 - 10 = 93

    // Sprite-sheet offset for the T-Rex.
    // Resolved lazily from the sprite definition (no Runner instance needed).
    var _spritePos = null;
    function getSpritePos() {
        if (!_spritePos) {
            var isHDPI = window.devicePixelRatio > 1;
            var def = isHDPI ? Runner.spriteDefinition.HDPI : Runner.spriteDefinition.LDPI;
            if (def) _spritePos = def.TREX;
        }
        return _spritePos || { x: 848, y: 2 };
    }

    // Animation frame X-offsets within the T-Rex sprite strip.
    var ANIM = {
        RUNNING:  [88, 132],
        JUMPING:  [0],
        DUCKING:  [264, 323],
        CRASHED:  [220]
    };

    // Single colour for elite dinos.
    var ELITE_COLOR = '#30d158';   // green

    // Shared offscreen canvas for colour tinting.
    // Sized to fit the largest sprite (WIDTH_DUCK x HEIGHT).
    var _tintCanvas = null;
    var _tintCtx = null;
    function getTintCanvas() {
        if (!_tintCanvas) {
            _tintCanvas = document.createElement('canvas');
            _tintCanvas.width = Trex.config.WIDTH_DUCK;
            _tintCanvas.height = Trex.config.HEIGHT;
            _tintCtx = _tintCanvas.getContext('2d');
        }
        return { canvas: _tintCanvas, ctx: _tintCtx };
    }

    /**
     * Invert a hex colour (#rrggbb) for night-mode compensation.
     * When CSS filter: invert(100%) is applied, pre-inverting the colour
     * makes it look correct on screen.
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

    // =========================================================================
    // GhostTrex constructor
    // =========================================================================

    /**
     * @param {number} index  Index in the population (0 .. POPULATION_SIZE-1).
     * @param {boolean} isElite  True if this individual is an elite survivor.
     * @constructor
     */
    function GhostTrex(index, isElite) {
        this.index = index;
        this.isElite = isElite;

        // Physics state (mirrors real Trex fields).
        this.xPos = Trex.config.START_X_POS;
        this.yPos = GROUND_Y;
        this.groundYPos = GROUND_Y;
        this.minJumpHeight = GROUND_Y - Trex.config.MIN_JUMP_HEIGHT;
        this.jumping = false;
        this.ducking = false;
        this.jumpVelocity = 0;
        this.reachedMinHeight = false;
        this.speedDrop = false;
        this.config = Trex.config;

        // Lifecycle.
        this.alive = true;
        this.fitness = 0;
        this.deathFrame = -1;    // frame counter when died (for fade-out)

        // Simple animation counter.
        this._frameCount = 0;
    }

    // -------------------------------------------------------------------------
    // Physics — exact mirrors of Trex methods
    // -------------------------------------------------------------------------

    GhostTrex.prototype.startJump = function (speed) {
        if (!this.jumping) {
            this.jumpVelocity = this.config.INIITAL_JUMP_VELOCITY - (speed / 10);
            this.jumping = true;
            this.reachedMinHeight = false;
            this.speedDrop = false;
        }
    };

    GhostTrex.prototype.setSpeedDrop = function () {
        this.speedDrop = true;
        this.jumpVelocity = 1;
    };

    GhostTrex.prototype.setDuck = function (on) {
        if (on) {
            this.ducking = true;
        } else {
            this.ducking = false;
        }
    };

    /**
     * Step physics forward one game frame (deltaTime = 1000/60).
     * Exact copy of Trex.updateJump logic.
     */
    GhostTrex.prototype.updatePhysics = function () {
        this._frameCount++;
        if (!this.jumping) return;

        // msPerFrame for JUMPING is 1000/60; framesElapsed = 1.0 at 60fps.
        var framesElapsed = 1.0;

        if (this.speedDrop) {
            this.yPos += Math.round(this.jumpVelocity *
                this.config.SPEED_DROP_COEFFICIENT * framesElapsed);
        } else {
            this.yPos += Math.round(this.jumpVelocity * framesElapsed);
        }

        this.jumpVelocity += this.config.GRAVITY * framesElapsed;

        // Min height reached?
        if (this.yPos < this.minJumpHeight || this.speedDrop) {
            this.reachedMinHeight = true;
        }

        // Max height / endJump.
        if (this.yPos < this.config.MAX_JUMP_HEIGHT || this.speedDrop) {
            if (this.reachedMinHeight &&
                this.jumpVelocity < this.config.DROP_VELOCITY) {
                this.jumpVelocity = this.config.DROP_VELOCITY;
            }
        }

        // Landed.  Use >= so exact-groundYPos landings are caught.
        if (this.yPos >= this.groundYPos) {
            this.yPos = this.groundYPos;
            this.jumping = false;
            this.jumpVelocity = 0;
            // Don't auto-duck after speed-drop landing.  The AI agent
            // makes a fresh decision each frame, so there's no "held key"
            // to continue into a duck.  This matches the real Trex's
            // reset() behaviour (which also clears speedDrop first).
            this.speedDrop = false;
        }
    };

    // -------------------------------------------------------------------------
    // Collision detection — same approach as the game engine
    // -------------------------------------------------------------------------

    /**
     * Check collision against the first obstacle in front of this ghost.
     * Returns true if colliding.
     */
    GhostTrex.prototype.checkCollision = function (obstacles) {
        for (var i = 0; i < obstacles.length; i++) {
            var obs = obstacles[i];
            if (obs.xPos + obs.typeConfig.width * obs.size < this.xPos) continue;

            // Outer bounding box.
            var tBox = new CollisionBox(
                this.xPos + 1, this.yPos + 1,
                this.config.WIDTH - 2, this.config.HEIGHT - 2);
            var oBox = new CollisionBox(
                obs.xPos + 1, obs.yPos + 1,
                obs.typeConfig.width * obs.size - 2,
                obs.typeConfig.height - 2);

            if (!boxCompare(tBox, oBox)) continue;

            // Detailed inner-box check.
            var tBoxes = this.ducking ?
                Trex.collisionBoxes.DUCKING : Trex.collisionBoxes.RUNNING;
            var oBoxes = obs.collisionBoxes;

            for (var t = 0; t < tBoxes.length; t++) {
                for (var o = 0; o < oBoxes.length; o++) {
                    var adjT = createAdjustedCollisionBox(tBoxes[t], tBox);
                    var adjO = createAdjustedCollisionBox(oBoxes[o], oBox);
                    if (boxCompare(adjT, adjO)) return true;
                }
            }
        }
        return false;
    };

    // -------------------------------------------------------------------------
    // Drawing — render as colour-tinted semi-transparent sprite
    // -------------------------------------------------------------------------

    /**
     * Draw this ghost onto the canvas context.
     * Elite ghosts are tinted with their assigned colour.
     * The best-alive ghost is drawn brighter with its colour.
     * Regular ghosts are drawn as dark silhouettes.
     * Dead ghosts fade out in red.
     *
     * @param {CanvasRenderingContext2D} ctx  The shared game canvas context.
     * @param {number} globalFrame  Global frame counter for animation cycling.
     * @param {number} bestAliveIdx  Index of the best-alive ghost (-1 if none).
     */
    GhostTrex.prototype.draw = function (ctx, globalFrame, bestAliveIdx) {
        var IS_HIDPI = window.devicePixelRatio > 1;

        // Determine alpha and tint colour.
        var alpha, tintColor;
        if (!this.alive) {
            // Fade-out over 30 frames after death.
            var fadeFrames = 30;
            var elapsed = globalFrame - this.deathFrame;
            if (elapsed > fadeFrames) return; // fully gone
            alpha = 0.3 * (1 - elapsed / fadeFrames);
            tintColor = '#ff3b30'; // red for dead
        } else if (this.index === bestAliveIdx) {
            alpha = 1.0;
            tintColor = '#0071e3'; // blue for best alive — fully opaque
        } else if (this.isElite) {
            alpha = 0.35;
            tintColor = ELITE_COLOR;
        } else {
            alpha = 0.10;
            tintColor = '#535353'; // dark grey silhouette
        }

        // Determine sprite frame.
        var frameX, srcW, destW;
        if (!this.alive) {
            frameX = ANIM.CRASHED[0];
            srcW = this.config.WIDTH - 2; // trim 2px to avoid edge artifact
            destW = this.config.WIDTH - 2;
        } else if (this.ducking) {
            var duckFrame = ANIM.DUCKING[Math.floor(globalFrame / 6) % 2];
            frameX = duckFrame;
            srcW = this.config.WIDTH_DUCK;
            destW = this.config.WIDTH_DUCK;
        } else if (this.jumping) {
            frameX = ANIM.JUMPING[0];
            srcW = this.config.WIDTH;
            destW = this.config.WIDTH;
        } else {
            var runFrame = ANIM.RUNNING[Math.floor(globalFrame / 6) % 2];
            frameX = runFrame;
            srcW = this.config.WIDTH;
            destW = this.config.WIDTH;
        }

        // Compute source rectangle from the sprite sheet.
        var sourceX = frameX;
        var sourceY = 0;
        var sourceW = srcW;
        var sourceH = this.config.HEIGHT;

        if (IS_HIDPI) {
            sourceX *= 2;
            sourceY *= 2;
            sourceW *= 2;
            sourceH *= 2;
        }

        var spritePos = getSpritePos();
        sourceX += spritePos.x;
        sourceY += spritePos.y;

        // --- Colour tint via offscreen canvas ---
        var tint = getTintCanvas();
        var tc = tint.ctx;
        var h = this.config.HEIGHT;

        // Pre-invert colour in night mode so it survives CSS invert(100%).
        var isNight = document.body.classList.contains('inverted');
        var color = isNight ? invertColor(tintColor) : tintColor;

        // 1. Draw sprite, then replace all pixels with the tint colour.
        //    This gives a clean solid-colour silhouette with no artifacts.
        //    Clear the full canvas (not just destW) to avoid leftover pixels.
        tc.clearRect(0, 0, _tintCanvas.width, _tintCanvas.height);
        tc.globalCompositeOperation = 'source-over';
        tc.globalAlpha = 1;
        tc.imageSmoothingEnabled = false;
        tc.drawImage(Runner.imageSprite,
            sourceX, sourceY, sourceW, sourceH,
            0, 0, destW, h);
        tc.globalCompositeOperation = 'source-in';
        tc.fillStyle = color;
        tc.fillRect(0, 0, destW, h);

        // 2. Draw the tinted result onto the game canvas.
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(tint.canvas,
            0, 0, destW, h,
            this.xPos, this.yPos, destW, h);
        ctx.restore();
    };

    // -------------------------------------------------------------------------
    // Reset for new generation
    // -------------------------------------------------------------------------

    GhostTrex.prototype.reset = function (isElite) {
        this.isElite = isElite;
        this.xPos = Trex.config.START_X_POS;
        this.yPos = GROUND_Y;
        this.jumping = false;
        this.ducking = false;
        this.jumpVelocity = 0;
        this.reachedMinHeight = false;
        this.speedDrop = false;
        this.alive = true;
        this.fitness = 0;
        this.deathFrame = -1;
        this._frameCount = 0;
    };

    // =========================================================================
    // Expose
    // =========================================================================

    window.GhostTrex = GhostTrex;
    window.GHOST_ELITE_COLOR = ELITE_COLOR;

})();
