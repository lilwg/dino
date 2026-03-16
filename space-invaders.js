// =============================================================================
// Space Invaders — Dino Edition
//
// T-Rex is the player. Pterodactyls & cacti from the dino sprite sheet.
// Day/night cycle with canvas inversion, mystery ship, pixel-erosion bunkers.
// =============================================================================
(function () {
    'use strict';

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------
    var CANVAS_W = 600;
    var CANVAS_H = 400;

    // Player
    var PLAYER_SPEED = 4;
    var PLAYER_W = 44;
    var PLAYER_H = 47;
    var PLAYER_Y = CANVAS_H - PLAYER_H - 16;
    var FIRE_COOLDOWN = 15;

    // Bullets
    var BULLET_W = 3;
    var BULLET_H = 10;
    var BULLET_SPEED = 6;
    var ENEMY_BULLET_W = 3;
    var ENEMY_BULLET_H = 10;
    var ENEMY_BULLET_SPEED = 3;
    var ENEMY_FIRE_CHANCE = 0.008;  // legacy, unused
    var MAX_ENEMY_BULLETS = 3;      // arcade: max 3 enemy shots on screen
    var ENEMY_RELOAD_RATE = 48;     // frames between shots (~0.8s at 60fps, arcade reload ~48 steps)

    // Alien grid — classic Space Invaders layout: 5 rows × 8 cols
    var ALIEN_COLS = 8;
    var ALIEN_ROWS = 5;
    var ALIEN_SPACING_X = 55;
    var ALIEN_SPACING_Y = 40;
    var ALIEN_START_X = 40;
    var ALIEN_START_Y = 35;
    var ALIEN_MOVE_SPEED = 1;
    var ALIEN_DROP = 12;

    // Classic Space Invaders scoring: 30 / 20 / 20 / 10 / 10
    var ALIEN_TYPES = [
        { name: 'PTERODACTYL',  w: 46, h: 40, points: 30 },
        { name: 'PTERODACTYL',  w: 46, h: 40, points: 20 },
        { name: 'CACTUS_SMALL', w: 17, h: 35, points: 20 },
        { name: 'CACTUS_SMALL', w: 17, h: 35, points: 10 },
        { name: 'CACTUS_SMALL', w: 17, h: 35, points: 10 }
    ];

    // Bunkers (pixel-based)
    var BUNKER_COUNT = 4;
    var BUNKER_W = 44;
    var BUNKER_H = 32;
    var BUNKER_Y = CANVAS_H - 95;
    var BUNKER_ERODE_R = 4; // radius of erosion on hit

    // Day/night cycle — time-based
    var DAY_DURATION = 1800;    // frames (~30s) of day
    var NIGHT_DURATION = 720;   // frames (~12s) of night

    // Mystery ship (drawn as simple saucer shape)
    var MYSTERY_SPEED = 1.5;
    var MYSTERY_POINT_VALUES = [50, 100, 150, 300]; // classic random scoring
    var MYSTERY_W = 40;
    var MYSTERY_H = 16;

    // Stars (from dino sprite sheet)
    var STAR_SPRITE = { x: 645, y: 2, size: 9 };
    var NUM_NIGHT_STARS = 12;
    var STAR_MAX_Y = 200;
    var STAR_SPEED = 0.3;

    // Moon (from dino sprite sheet)
    var MOON_SPRITE = { x: 484, y: 2, w: 20, h: 40 };
    var MOON_PHASES = [140, 120, 100, 60, 40, 20, 0];
    var MOON_SPEED = 0.25;

    // Dino sprite sheet coordinates (LDPI)
    var SPRITES = {
        TREX_IDLE:  { x: 848 + 44,  y: 2, w: 44, h: 47 },
        TREX_CRASH: { x: 848 + 220, y: 2, w: 44, h: 47 },
        PTERO1:     { x: 134,       y: 2, w: 46, h: 40 },
        PTERO2:     { x: 134 + 46,  y: 2, w: 46, h: 40 },
        CACTUS_SM:  { x: 228,       y: 2, w: 17, h: 35 }
    };

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    function padScore(n) {
        var s = '' + n;
        while (s.length < 5) s = '0' + s;
        return s;
    }

    // -------------------------------------------------------------------------
    // Explosion sprite (drawn once to offscreen canvas)
    // Classic Space Invaders "poof" — an X-burst pattern
    // -------------------------------------------------------------------------
    var explosionCanvas = null;
    var EXPL_SIZE = 30;
    function createExplosionSprite() {
        explosionCanvas = document.createElement('canvas');
        explosionCanvas.width = EXPL_SIZE;
        explosionCanvas.height = EXPL_SIZE;
        var ctx = explosionCanvas.getContext('2d');
        var cx = EXPL_SIZE / 2, cy = EXPL_SIZE / 2;
        ctx.fillStyle = '#535353';
        // Center dot
        ctx.fillRect(cx - 1, cy - 1, 3, 3);
        // 8 rays
        var rays = [
            [-8, -8], [8, -8], [-8, 8], [8, 8],
            [0, -10], [0, 10], [-10, 0], [10, 0]
        ];
        for (var i = 0; i < rays.length; i++) {
            ctx.fillRect(cx + rays[i][0] - 1, cy + rays[i][1] - 1, 3, 3);
        }
        // Short lines connecting
        ctx.strokeStyle = '#535353';
        ctx.lineWidth = 1;
        for (var i = 0; i < 4; i++) {
            ctx.beginPath();
            ctx.moveTo(cx + rays[i][0] * 0.3, cy + rays[i][1] * 0.3);
            ctx.lineTo(cx + rays[i][0], cy + rays[i][1]);
            ctx.stroke();
        }
    }

    // -------------------------------------------------------------------------
    // Bunker pixel buffer
    // -------------------------------------------------------------------------
    function createBunkerBuffer(w, h) {
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#535353';
        // Arch shape
        ctx.fillRect(0, 8, w, h - 8);
        ctx.fillRect(4, 4, w - 8, 4);
        ctx.fillRect(8, 0, w - 16, 4);
        // Doorway cutout
        ctx.clearRect(Math.floor(w / 2) - 6, h - 10, 12, 10);
        return canvas;
    }

    function erodeBunker(bunkerCanvas, hitX, hitY, radius) {
        var ctx = bunkerCanvas.getContext('2d');
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillRect(hitX - radius, hitY - radius, radius * 2, radius * 2);
        ctx.globalCompositeOperation = 'source-over';
    }

    function bunkerHasPixels(bunkerCanvas) {
        var ctx = bunkerCanvas.getContext('2d');
        var d = ctx.getImageData(0, 0, bunkerCanvas.width, bunkerCanvas.height).data;
        for (var i = 3; i < d.length; i += 4) {
            if (d[i] > 0) return true;
        }
        return false;
    }

    function bunkerPixelHit(bunkerCanvas, localX, localY) {
        if (localX < 0 || localY < 0 || localX >= bunkerCanvas.width || localY >= bunkerCanvas.height) return false;
        var ctx = bunkerCanvas.getContext('2d');
        var d = ctx.getImageData(Math.floor(localX), Math.floor(localY), 1, 1).data;
        return d[3] > 0;
    }

    // -------------------------------------------------------------------------
    // Game
    // -------------------------------------------------------------------------
    function Game(canvas, options) {
        options = options || {};
        this.isPrimary = options.primary !== false;
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.spriteImg = null;   // dino sprite sheet

        this.keys = {};
        this.gameOver = false;
        this.paused = false;
        this.score = 0;
        this.highScore = parseInt(localStorage.getItem('dino-invaders-hi')) || 0;
        this.lives = 3;
        this.wave = 1;
        this.frameCount = 0;

        this.player = { x: CANVAS_W / 2 - PLAYER_W / 2, y: PLAYER_Y, cooldown: 0 };
        this.playerFacing = 1;    // 1=right, -1=left
        this.invincible = 0;      // invincibility frames after being hit
        this.firePressed = false;  // track press-release for no auto-fire
        this.bullets = [];
        this.enemyBullets = [];
        this.enemyReloadTimer = 0;  // arcade-style reload cooldown
        this.aliens = [];
        this.bunkers = [];       // { x, y, w, h, canvas }
        this.explosions = [];    // { x, y, ttl }

        // Alien movement
        this.alienDir = 1;
        this.alienSpeed = ALIEN_MOVE_SPEED;
        this.alienMoveTimer = 0;
        this.alienMoveInterval = 30;
        this.animFrame = 0;

        // Day/night
        this.inverted = false;
        this.dayTimer = 0;

        // Night elements (moon + stars)
        this.nightOpacity = 0;
        this.moonPhase = 0;
        this.moonX = CANVAS_W - 50;
        this.moonY = 25;
        this.nightStars = [];

        // Mystery ship
        this.mystery = null; // { x, y, dir }

        this.aiAgent = null;
        this.speedMultiplier = 1;
        this.difficultyLevel = 1; // 1=Normal, 2=Hard, 3=Brutal

        createExplosionSprite();
        this._placeNightStars();
        this._init();
    }

    Game.prototype._placeNightStars = function () {
        this.nightStars = [];
        var segW = Math.round(CANVAS_W / NUM_NIGHT_STARS);
        for (var i = 0; i < NUM_NIGHT_STARS; i++) {
            this.nightStars.push({
                x: Math.random() * segW + segW * i,
                y: Math.random() * STAR_MAX_Y,
                sourceY: STAR_SPRITE.y + STAR_SPRITE.size * (i % 2)
            });
        }
    };

    Game.prototype._init = function () {
        this.spriteImg = document.getElementById('offline-resources-1x');
        if (!this.spriteImg) {
            this.spriteImg = new Image();
            this.spriteImg.src = 'assets/default_100_percent/100-offline-sprite.png';
        }

        if (this.isPrimary) this._initKeyboard();
        this._spawnAliens();
        this._spawnBunkers();
    };

    Game.prototype._initKeyboard = function () {
        var self = this;
        document.addEventListener('keydown', function (e) {
            self.keys[e.keyCode] = true;
            if ([32, 37, 38, 39, 40, 87].indexOf(e.keyCode) !== -1) e.preventDefault();
            if (self.gameOver && (e.keyCode === 82 || e.keyCode === 13)) self.restart();
        });
        document.addEventListener('keyup', function (e) {
            self.keys[e.keyCode] = false;
        });
    };

    // -------------------------------------------------------------------------
    // Spawning
    // -------------------------------------------------------------------------
    Game.prototype._spawnAliens = function () {
        // Difficulty adds extra "phantom waves" — aliens start lower, move faster, fire more
        var extraWaves = [0, 2, 5][Math.min(this.difficultyLevel, 3) - 1] || 0;
        var effectiveWave = this.wave + extraWaves;
        var dropRows = Math.min(extraWaves, 4); // how many rows lower aliens start

        this.aliens = [];
        for (var row = 0; row < ALIEN_ROWS; row++) {
            for (var col = 0; col < ALIEN_COLS; col++) {
                var type = ALIEN_TYPES[row];
                this.aliens.push({
                    x: ALIEN_START_X + col * ALIEN_SPACING_X + (ALIEN_TYPES[0].w - type.w) / 2,
                    y: ALIEN_START_Y + row * ALIEN_SPACING_Y + dropRows * ALIEN_DROP,
                    w: type.w,
                    h: type.h,
                    type: type.name,
                    points: type.points,
                    alive: true,
                    row: row,
                    col: col
                });
            }
        }
        this.alienDir = 1;
        this.alienMoveTimer = 0;
        this.alienMoveInterval = Math.max(8, 30 - (effectiveWave - 1) * 3);
        this.alienSpeed = ALIEN_MOVE_SPEED + (effectiveWave - 1) * 0.3;
    };

    Game.prototype._spawnBunkers = function () {
        this.bunkers = [];
        var gap = CANVAS_W / (BUNKER_COUNT + 1);
        for (var i = 0; i < BUNKER_COUNT; i++) {
            this.bunkers.push({
                x: gap * (i + 1) - BUNKER_W / 2,
                y: BUNKER_Y,
                w: BUNKER_W,
                h: BUNKER_H,
                canvas: createBunkerBuffer(BUNKER_W, BUNKER_H)
            });
        }
    };

    // -------------------------------------------------------------------------
    // Update
    // -------------------------------------------------------------------------
    Game.prototype.update = function () {
        if (this.gameOver) {
            this._checkAIRestart();
            return;
        }
        if (this.paused) return;
        this.frameCount++;

        if (this.aiAgent && this.aiAgent.enabled) this.aiAgent.update(this);

        this._updatePlayer();
        this._updateBullets();
        this._updateAliens();
        this._updateEnemyBullets();
        this._updateExplosions();
        this._updateDayNight();
        this._updateMystery();
        this._checkWaveComplete();
    };

    // --- Day/night (time-based) ---
    Game.prototype._updateDayNight = function () {
        this.dayTimer++;

        if (!this.inverted && this.dayTimer >= DAY_DURATION) {
            this.inverted = true;
            this.dayTimer = 0;
            this.moonPhase = (this.moonPhase + 1) % MOON_PHASES.length;
            // Spawn mystery ship with night
            if (!this.mystery) this._spawnMystery();
        } else if (this.inverted && this.dayTimer >= NIGHT_DURATION) {
            this.inverted = false;
            this.dayTimer = 0;
        }

        // Fade night elements
        if (this.inverted) {
            if (this.nightOpacity < 1) this.nightOpacity += 0.035;
            if (this.nightOpacity > 1) this.nightOpacity = 1;
        } else {
            if (this.nightOpacity > 0) this.nightOpacity -= 0.035;
            if (this.nightOpacity < 0) this.nightOpacity = 0;
        }

        // Scroll moon and stars
        if (this.nightOpacity > 0) {
            this.moonX -= MOON_SPEED;
            if (this.moonX < -MOON_SPRITE.w) this.moonX = CANVAS_W;
            for (var i = 0; i < this.nightStars.length; i++) {
                this.nightStars[i].x -= STAR_SPEED;
                if (this.nightStars[i].x < -STAR_SPRITE.size)
                    this.nightStars[i].x = CANVAS_W;
            }
        } else {
            this._placeNightStars();
        }
    };

    // --- Mystery ship ---
    Game.prototype._spawnMystery = function () {
        var dir = Math.random() < 0.5 ? 1 : -1;
        this.mystery = {
            x: dir === 1 ? -MYSTERY_W : CANVAS_W,
            y: 10,
            dir: dir
        };
    };

    Game.prototype._updateMystery = function () {
        if (!this.mystery) return;
        this.mystery.x += this.mystery.dir * MYSTERY_SPEED;
        if (this.mystery.x < -MYSTERY_W - 20 || this.mystery.x > CANVAS_W + 20) {
            this.mystery = null;
        }
    };

    // --- Player ---
    Game.prototype._updatePlayer = function () {
        if (this.invincible > 0) this.invincible--;

        if (this.keys[37] || this.keys[65]) {
            this.player.x = Math.max(0, this.player.x - PLAYER_SPEED);
            this.playerFacing = -1;
        }
        if (this.keys[39] || this.keys[68]) {
            this.player.x = Math.min(CANVAS_W - PLAYER_W, this.player.x + PLAYER_SPEED);
            this.playerFacing = 1;
        }

        if (this.player.cooldown > 0) this.player.cooldown--;
        var fireKey = this.keys[32] || this.keys[38] || this.keys[87]; // Space, Up, W
        if (fireKey && !this.firePressed && this.player.cooldown === 0 && this.bullets.length === 0) {
            this.bullets.push({
                x: this.player.x + PLAYER_W / 2 - BULLET_W / 2,
                y: this.player.y - BULLET_H,
                w: BULLET_W, h: BULLET_H
            });
            this.player.cooldown = FIRE_COOLDOWN;
        }
        this.firePressed = !!fireKey;
    };

    // --- Player bullets ---
    Game.prototype._updateBullets = function () {
        for (var i = this.bullets.length - 1; i >= 0; i--) {
            var hit = false;

            // Hit mystery ship
            if (this.mystery && this._collides(this.bullets[i], {
                x: this.mystery.x, y: this.mystery.y, w: MYSTERY_W, h: MYSTERY_H
            })) {
                var mysteryPts = MYSTERY_POINT_VALUES[Math.floor(Math.random() * MYSTERY_POINT_VALUES.length)];
                this.score += mysteryPts;
                this.explosions.push({ x: this.mystery.x + MYSTERY_W / 2, y: this.mystery.y + MYSTERY_H / 2, ttl: 20, text: '+' + mysteryPts });
                this.mystery = null;
                this.bullets.splice(i, 1);
                continue;
            }

            // Hit aliens
            for (var j = 0; j < this.aliens.length; j++) {
                var a = this.aliens[j];
                if (!a.alive) continue;
                if (this._collides(this.bullets[i], a)) {
                    a.alive = false;
                    this.score += a.points;
                    this.explosions.push({ x: a.x + a.w / 2, y: a.y + a.h / 2, ttl: 15 });
                    this.bullets.splice(i, 1);
                    hit = true;
                    var alive = 0;
                    for (var k = 0; k < this.aliens.length; k++) if (this.aliens[k].alive) alive++;
                    this.alienMoveInterval = Math.max(2, Math.floor(3 + alive * 0.8));
                    break;
                }
            }
            if (hit) continue;

            // Hit bunkers — scan full bullet height, erode at first solid pixel
            for (var b = 0; b < this.bunkers.length; b++) {
                var bk = this.bunkers[b];
                if (this._collides(this.bullets[i], bk)) {
                    var lx = this.bullets[i].x + BULLET_W / 2 - bk.x;
                    for (var py = BULLET_H - 1; py >= 0; py--) {
                        var ly = this.bullets[i].y + py - bk.y;
                        if (bunkerPixelHit(bk.canvas, lx, ly)) {
                            erodeBunker(bk.canvas, lx, ly, BUNKER_ERODE_R);
                            this.bullets.splice(i, 1);
                            hit = true;
                            break;
                        }
                    }
                    if (hit) break;
                }
            }
            if (hit) continue;

            // Move bullet AFTER collision checks so it doesn't skip bunker bottom rows
            this.bullets[i].y -= BULLET_SPEED;
            if (this.bullets[i].y + BULLET_H < 0) { this.bullets.splice(i, 1); }
        }
    };

    // --- Alien movement & firing ---
    Game.prototype._updateAliens = function () {
        this.alienMoveTimer++;
        if (this.alienMoveTimer < this.alienMoveInterval) return;
        this.alienMoveTimer = 0;
        this.animFrame = 1 - this.animFrame;

        var shouldDrop = false;
        for (var i = 0; i < this.aliens.length; i++) {
            var a = this.aliens[i]; if (!a.alive) continue;
            var nx = a.x + this.alienDir * this.alienSpeed * 8;
            if (nx < 0 || nx + a.w > CANVAS_W) { shouldDrop = true; break; }
        }

        for (var i = 0; i < this.aliens.length; i++) {
            if (!this.aliens[i].alive) continue;
            if (shouldDrop) this.aliens[i].y += ALIEN_DROP;
            else this.aliens[i].x += this.alienDir * this.alienSpeed * 8;
            if (this.aliens[i].y + this.aliens[i].h >= PLAYER_Y) {
                this.gameOver = true;
                if (this.score > this.highScore) { this.highScore = this.score; localStorage.setItem('dino-invaders-hi', this.highScore); }
                return;
            }
        }
        if (shouldDrop) this.alienDir *= -1;

        // Enemy fire — arcade-style: max 3 bullets, reload timer, bottom-of-column only
        // Skip random firing during simulation (deterministic lookahead)
        if (this._suppressEnemyFire) return;
        this.enemyReloadTimer--;
        if (this.enemyReloadTimer > 0) return;
        if (this.enemyBullets.length >= MAX_ENEMY_BULLETS) return;

        // Find bottom-most alive alien in each column (only they can fire)
        var shooters = [];
        for (var col = 0; col < ALIEN_COLS; col++) {
            var lowest = null;
            for (var i = 0; i < this.aliens.length; i++) {
                var a = this.aliens[i];
                if (a.alive && a.col === col && (!lowest || a.y > lowest.y)) lowest = a;
            }
            if (lowest) shooters.push(lowest);
        }
        if (shooters.length === 0) return;

        // Pick a random shooter and fire
        var shooter = shooters[Math.floor(Math.random() * shooters.length)];
        this.enemyBullets.push({
            x: shooter.x + shooter.w / 2 - ENEMY_BULLET_W / 2,
            y: shooter.y + shooter.h,
            w: ENEMY_BULLET_W, h: ENEMY_BULLET_H
        });

        // Reload rate decreases (faster firing) as aliens die, like arcade
        var alive = 0;
        for (var i = 0; i < this.aliens.length; i++) if (this.aliens[i].alive) alive++;
        var reloadScale = Math.max(0.3, alive / (ALIEN_ROWS * ALIEN_COLS));
        this.enemyReloadTimer = Math.floor(ENEMY_RELOAD_RATE * reloadScale);
    };

    // --- Enemy bullets ---
    Game.prototype._updateEnemyBullets = function () {
        for (var i = this.enemyBullets.length - 1; i >= 0; i--) {
            this.enemyBullets[i].y += ENEMY_BULLET_SPEED;
            if (this.enemyBullets[i].y > CANVAS_H) { this.enemyBullets.splice(i, 1); continue; }

            // Hit player (skip if invincible)
            if (this.invincible <= 0 && this._collides(this.enemyBullets[i], {
                x: this.player.x, y: this.player.y, w: PLAYER_W, h: PLAYER_H
            })) {
                this.enemyBullets.splice(i, 1);
                this.lives--;
                this.explosions.push({
                    x: this.player.x + PLAYER_W / 2,
                    y: this.player.y + PLAYER_H / 2, ttl: 25
                });
                if (this.lives <= 0) {
                    this.gameOver = true;
                    if (this.score > this.highScore) { this.highScore = this.score; localStorage.setItem('dino-invaders-hi', this.highScore); }
                } else {
                    this.invincible = 90; // ~1.5s invincibility after hit
                }
                continue;
            }

            // Hit bunkers — scan full bullet height, erode at first solid pixel
            var ebHit = false;
            for (var b = 0; b < this.bunkers.length; b++) {
                var bk = this.bunkers[b];
                if (this._collides(this.enemyBullets[i], bk)) {
                    var lx = this.enemyBullets[i].x + ENEMY_BULLET_W / 2 - bk.x;
                    for (var py = 0; py < ENEMY_BULLET_H; py++) {
                        var ly = this.enemyBullets[i].y + py - bk.y;
                        if (bunkerPixelHit(bk.canvas, lx, ly)) {
                            erodeBunker(bk.canvas, lx, ly, BUNKER_ERODE_R);
                            this.enemyBullets.splice(i, 1);
                            ebHit = true;
                            break;
                        }
                    }
                    if (ebHit) break;
                }
            }
        }
    };

    Game.prototype._updateExplosions = function () {
        for (var i = this.explosions.length - 1; i >= 0; i--) {
            this.explosions[i].ttl--;
            if (this.explosions[i].ttl <= 0) this.explosions.splice(i, 1);
        }
    };

    Game.prototype._checkWaveComplete = function () {
        for (var i = 0; i < this.aliens.length; i++) if (this.aliens[i].alive) return;
        this.wave++;
        this.enemyBullets = [];
        this._spawnAliens();
    };

    Game.prototype._collides = function (a, b) {
        return a.x < b.x + b.w && a.x + a.w > b.x &&
               a.y < b.y + b.h && a.y + a.h > b.y;
    };

    // -------------------------------------------------------------------------
    // Draw
    // -------------------------------------------------------------------------
    Game.prototype.draw = function () {
        var ctx = this.ctx;

        ctx.fillStyle = '#f7f7f7';
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

        this._drawNightElements(ctx);
        this._drawGround(ctx);
        this._drawBunkers(ctx);
        this._drawPlayer(ctx);
        this._drawAliens(ctx);
        this._drawMystery(ctx);
        this._drawBullets(ctx);
        this._drawExplosions(ctx);
        this._drawHUD(ctx);

        if (this.gameOver) this._drawGameOver(ctx);

        // Canvas inversion for night mode
        if (this.inverted) {
            ctx.globalCompositeOperation = 'difference';
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
            ctx.globalCompositeOperation = 'source-over';
        }
    };

    Game.prototype._drawNightElements = function (ctx) {
        if (this.nightOpacity <= 0 || !this.spriteImg || !this.spriteImg.complete) return;
        ctx.save();
        ctx.globalAlpha = this.nightOpacity;

        // Stars (6 of them)
        for (var i = 0; i < this.nightStars.length; i++) {
            var s = this.nightStars[i];
            ctx.drawImage(this.spriteImg,
                STAR_SPRITE.x, s.sourceY, STAR_SPRITE.size, STAR_SPRITE.size,
                Math.round(s.x), s.y, STAR_SPRITE.size, STAR_SPRITE.size);
        }

        // Moon
        var mSrcX = MOON_SPRITE.x + MOON_PHASES[this.moonPhase];
        var mSrcW = this.moonPhase === 3 ? MOON_SPRITE.w * 2 : MOON_SPRITE.w;
        var mOutW = this.moonPhase === 3 ? MOON_SPRITE.w * 2 : MOON_SPRITE.w;
        ctx.drawImage(this.spriteImg,
            mSrcX, MOON_SPRITE.y, mSrcW, MOON_SPRITE.h,
            Math.round(this.moonX), this.moonY, mOutW, MOON_SPRITE.h);

        ctx.globalAlpha = 1;
        ctx.restore();
    };

    Game.prototype._drawGround = function (ctx) {
        ctx.strokeStyle = '#535353';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, CANVAS_H - 8);
        ctx.lineTo(CANVAS_W, CANVAS_H - 8);
        ctx.stroke();
    };

    Game.prototype._drawSprite = function (ctx, sprite, dx, dy, scale) {
        scale = scale || 1;
        if (this.spriteImg && this.spriteImg.complete) {
            ctx.drawImage(this.spriteImg,
                sprite.x, sprite.y, sprite.w, sprite.h,
                dx, dy, sprite.w * scale, sprite.h * scale);
        }
    };

    Game.prototype._drawSpriteFlipped = function (ctx, sprite, dx, dy, scale) {
        scale = scale || 1;
        if (this.spriteImg && this.spriteImg.complete) {
            ctx.save();
            ctx.translate(dx + sprite.w * scale, dy);
            ctx.scale(-1, 1);
            ctx.drawImage(this.spriteImg,
                sprite.x, sprite.y, sprite.w, sprite.h,
                0, 0, sprite.w * scale, sprite.h * scale);
            ctx.restore();
        }
    };

    Game.prototype._drawPlayer = function (ctx) {
        // Flash when invincible (blink every 4 frames)
        if (this.invincible > 0 && Math.floor(this.invincible / 4) % 2 === 1) return;

        var spr = this.gameOver ? SPRITES.TREX_CRASH : SPRITES.TREX_IDLE;
        if (this.playerFacing < 0) {
            this._drawSpriteFlipped(ctx, spr, this.player.x, this.player.y);
        } else {
            this._drawSprite(ctx, spr, this.player.x, this.player.y);
        }
        // Draw eye
        if (!this.gameOver) {
            ctx.fillStyle = '#f7f7f7'; // light dot (inverts to dark at night)
            if (this.playerFacing < 0) {
                ctx.fillRect(this.player.x + 6, this.player.y + 6, 2, 2);
            } else {
                ctx.fillRect(this.player.x + 36, this.player.y + 6, 2, 2);
            }
        }
    };

    Game.prototype._drawAliens = function (ctx) {
        for (var i = 0; i < this.aliens.length; i++) {
            var a = this.aliens[i];
            if (!a.alive) continue;

            if (a.type === 'PTERODACTYL') {
                var pframe = this.animFrame === 0 ? SPRITES.PTERO1 : SPRITES.PTERO2;
                // Face the direction the aliens are moving
                // (dino sheet pteros face left naturally, flip for right)
                if (this.alienDir > 0) {
                    this._drawSpriteFlipped(ctx, pframe, a.x, a.y);
                } else {
                    this._drawSprite(ctx, pframe, a.x, a.y);
                }
            } else {
                this._drawSprite(ctx, SPRITES.CACTUS_SM,
                    a.x + (a.w - SPRITES.CACTUS_SM.w) / 2,
                    a.y + (a.h - SPRITES.CACTUS_SM.h) / 2);
            }
        }
    };

    Game.prototype._drawMystery = function (ctx) {
        if (!this.mystery) return;
        // Simple saucer shape
        var mx = this.mystery.x, my = this.mystery.y;
        ctx.fillStyle = '#535353';
        // Dome
        ctx.fillRect(mx + 14, my, 12, 4);
        ctx.fillRect(mx + 10, my + 4, 20, 4);
        // Body
        ctx.fillRect(mx + 4, my + 8, 32, 4);
        ctx.fillRect(mx, my + 12, 40, 4);
        // Lights
        ctx.fillRect(mx + 8, my + 12, 2, 2);
        ctx.fillRect(mx + 19, my + 12, 2, 2);
        ctx.fillRect(mx + 30, my + 12, 2, 2);
    };

    Game.prototype._drawBullets = function (ctx) {
        ctx.fillStyle = '#535353';
        for (var i = 0; i < this.bullets.length; i++) {
            var b = this.bullets[i];
            ctx.fillRect(b.x, b.y, b.w, b.h);
        }
        for (var i = 0; i < this.enemyBullets.length; i++) {
            var b = this.enemyBullets[i];
            ctx.fillRect(b.x, b.y, b.w, b.h);
        }
    };

    Game.prototype._drawBunkers = function (ctx) {
        for (var i = 0; i < this.bunkers.length; i++) {
            var bk = this.bunkers[i];
            ctx.drawImage(bk.canvas, bk.x, bk.y);
        }
    };

    Game.prototype._drawExplosions = function (ctx) {
        if (!explosionCanvas) return;
        for (var i = 0; i < this.explosions.length; i++) {
            var e = this.explosions[i];
            var alpha = e.ttl / 15;
            ctx.globalAlpha = Math.min(1, alpha);
            ctx.drawImage(explosionCanvas,
                e.x - EXPL_SIZE / 2, e.y - EXPL_SIZE / 2);
            // Show score text for mystery ship hits
            if (e.text) {
                ctx.font = 'bold 12px "Courier New", monospace';
                ctx.fillStyle = '#f44';
                ctx.textAlign = 'center';
                ctx.fillText(e.text, e.x, e.y - EXPL_SIZE / 2 - 2);
            }
        }
        ctx.globalAlpha = 1;
    };

    Game.prototype._drawHUD = function (ctx) {
        ctx.font = '600 13px "Courier New", monospace';
        ctx.fillStyle = '#535353';
        ctx.textAlign = 'left';
        ctx.fillText('HI ' + padScore(this.highScore), 10, 18);
        ctx.fillText('  ' + padScore(this.score), 100, 18);
        ctx.textAlign = 'center';
        ctx.fillText('WAVE ' + this.wave, CANVAS_W / 2, 18);
        ctx.textAlign = 'right';
        ctx.fillText(this.lives + '\u00d7', CANVAS_W - 10 - this.lives * 26, 17);
        for (var i = 0; i < this.lives; i++) {
            this._drawSprite(ctx, SPRITES.TREX_IDLE,
                CANVAS_W - 8 - (i + 1) * 24, 5, 0.4);
        }
        ctx.textAlign = 'left';
    };

    Game.prototype._drawGameOver = function (ctx) {
        ctx.fillStyle = 'rgba(247, 247, 247, 0.8)';
        ctx.fillRect(0, CANVAS_H / 2 - 40, CANVAS_W, 80);
        ctx.fillStyle = '#535353';
        ctx.font = '600 20px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('GAME OVER', CANVAS_W / 2, CANVAS_H / 2 - 5);
        ctx.font = '13px "Courier New", monospace';
        ctx.fillText('Score: ' + padScore(this.score) + '   Wave: ' + this.wave,
            CANVAS_W / 2, CANVAS_H / 2 + 16);
        ctx.font = '11px "Courier New", monospace';
        ctx.fillStyle = '#86868b';
        ctx.fillText('Press R or ENTER to restart', CANVAS_W / 2, CANVAS_H / 2 + 32);
        ctx.textAlign = 'left';
    };

    // -------------------------------------------------------------------------
    // Game loop
    // -------------------------------------------------------------------------
    Game.prototype.start = function () {
        var self = this;
        (function loop() {
            var n = self.speedMultiplier || 1;
            for (var i = 0; i < n; i++) self.update();
            self.draw();
            requestAnimationFrame(loop);
        })();
    };

    Game.prototype.restart = function () {
        this.score = 0;
        this.lives = 3;
        this.wave = 1;
        this.gameOver = false;
        this.frameCount = 0;
        this.bullets = [];
        this.enemyBullets = [];
        this.enemyReloadTimer = 0;
        this.explosions = [];
        this.player.x = CANVAS_W / 2 - PLAYER_W / 2;
        this.player.cooldown = 0;
        this.playerFacing = 1;
        this.invincible = 0;
        this.firePressed = false;
        this.inverted = false;
        this.dayTimer = 0;
        this.nightOpacity = 0;
        this.mystery = null;
        this._placeNightStars();
        this._spawnAliens();
        this._spawnBunkers();
    };

    // -------------------------------------------------------------------------
    // AI interface
    // -------------------------------------------------------------------------
    Game.prototype.extractState = function () {
        var playerCX = this.player.x + PLAYER_W / 2;

        // --- Alien info ---
        var nearestAlien = null, nearestDist = Infinity;
        var lowestAlienY = 0;
        for (var i = 0; i < this.aliens.length; i++) {
            var a = this.aliens[i]; if (!a.alive) continue;
            var dist = Math.abs(a.x + a.w / 2 - playerCX);
            if (dist < nearestDist) { nearestDist = dist; nearestAlien = a; }
            if (a.y + a.h > lowestAlienY) lowestAlienY = a.y + a.h;
        }

        // --- Sort ALL enemy bullets by distance to player (closest first) ---
        var sortedBullets = [];
        for (var i = 0; i < this.enemyBullets.length; i++) {
            var b = this.enemyBullets[i];
            var dy = PLAYER_Y - b.y;
            if (dy > 0) sortedBullets.push({ x: b.x, y: b.y, dy: dy, dx: b.x + 1.5 - playerCX });
        }
        sortedBullets.sort(function (a, b) { return a.dy - b.dy; });

        var b1 = sortedBullets[0] || null;
        var b2 = sortedBullets[1] || null;
        var b3 = sortedBullets[2] || null;
        var b4 = sortedBullets[3] || null;
        var b5 = sortedBullets[4] || null;

        var aliveCount = 0;
        for (var i = 0; i < this.aliens.length; i++) if (this.aliens[i].alive) aliveCount++;

        return {
            // Player position (1)
            playerX: this.player.x / CANVAS_W,
            // Nearest alien (3)
            nearestAlienDx: nearestAlien ? (nearestAlien.x + nearestAlien.w / 2 - playerCX) / CANVAS_W : 0,
            nearestAlienY: nearestAlien ? nearestAlien.y / CANVAS_H : 0,
            alienDir: this.alienDir,
            // Bullet 1 — closest (3)
            b1Dx: b1 ? b1.dx / CANVAS_W : 0,
            b1Y:  b1 ? b1.y / CANVAS_H : 0,
            b1Dy: b1 ? b1.dy / CANVAS_H : 0,
            // Bullet 2 (3)
            b2Dx: b2 ? b2.dx / CANVAS_W : 0,
            b2Y:  b2 ? b2.y / CANVAS_H : 0,
            b2Dy: b2 ? b2.dy / CANVAS_H : 0,
            // Bullet 3 (3)
            b3Dx: b3 ? b3.dx / CANVAS_W : 0,
            b3Y:  b3 ? b3.y / CANVAS_H : 0,
            b3Dy: b3 ? b3.dy / CANVAS_H : 0,
            // Bullet 4 (3)
            b4Dx: b4 ? b4.dx / CANVAS_W : 0,
            b4Y:  b4 ? b4.y / CANVAS_H : 0,
            b4Dy: b4 ? b4.dy / CANVAS_H : 0,
            // Bullet 5 (3)
            b5Dx: b5 ? b5.dx / CANVAS_W : 0,
            b5Y:  b5 ? b5.y / CANVAS_H : 0,
            b5Dy: b5 ? b5.dy / CANVAS_H : 0,
            // Game state (5)
            bulletCount: Math.min(this.enemyBullets.length / 6, 1),
            aliensAlive: aliveCount / (ALIEN_ROWS * ALIEN_COLS),
            canFire: (this.player.cooldown === 0 && this.bullets.length === 0) ? 1 : 0,
            wave: Math.min(this.wave / 10, 1),
            lowestAlienY: lowestAlienY / CANVAS_H
        };
    };

    Game.prototype.executeAction = function (action) {
        this.firePressed = false; // allow AI to fire without press-release cycle
        this.keys[37] = false; this.keys[39] = false; this.keys[32] = false;
        switch (action) {
            case 0: this.keys[37] = true; break;
            case 1: this.keys[39] = true; break;
            case 2: this.keys[32] = true; break;
            case 3: this.keys[37] = true; this.keys[32] = true; break;
            case 4: this.keys[39] = true; this.keys[32] = true; break;
            case 5: break;
        }
    };

    // Returns state as flat array (for neural networks)
    Game.prototype.extractStateArray = function () {
        var s = this.extractState();
        return [
            s.playerX,
            s.nearestAlienDx, s.nearestAlienY, s.alienDir,
            s.b1Dx, s.b1Y, s.b1Dy,
            s.b2Dx, s.b2Y, s.b2Dy,
            s.b3Dx, s.b3Y, s.b3Dy,
            s.b4Dx, s.b4Y, s.b4Dy,
            s.b5Dx, s.b5Y, s.b5Dy,
            s.bulletCount, s.aliensAlive, s.canFire, s.wave, s.lowestAlienY
        ];
    };

    // Run N update ticks without drawing (for fast AI training)
    Game.prototype.stepHeadless = function (n) {
        for (var i = 0; i < n; i++) {
            if (this.gameOver) break;
            this.update();
        }
    };

    // Auto-restart for AI: call after game over detection
    Game.prototype._checkAIRestart = function () {
        if (this.gameOver && this.aiAgent && this.aiAgent.enabled) {
            if (this.aiAgent.onCrash) this.aiAgent.onCrash(this);
            this.restart();
        }
    };

    // -------------------------------------------------------------------------
    // State snapshot / restore (for simulation-based AI)
    // -------------------------------------------------------------------------
    Game.prototype.snapshotState = function () {
        var alienSnap = new Array(this.aliens.length);
        for (var i = 0; i < this.aliens.length; i++) {
            var a = this.aliens[i];
            alienSnap[i] = { x: a.x, y: a.y, alive: a.alive };
        }
        var bulletSnap = new Array(this.bullets.length);
        for (var i = 0; i < this.bullets.length; i++) {
            bulletSnap[i] = { x: this.bullets[i].x, y: this.bullets[i].y };
        }
        var ebSnap = new Array(this.enemyBullets.length);
        for (var i = 0; i < this.enemyBullets.length; i++) {
            ebSnap[i] = { x: this.enemyBullets[i].x, y: this.enemyBullets[i].y };
        }
        // Clone bunker pixel data
        var bunkerSnap = new Array(this.bunkers.length);
        for (var i = 0; i < this.bunkers.length; i++) {
            var bk = this.bunkers[i];
            var ctx = bk.canvas.getContext('2d');
            bunkerSnap[i] = {
                x: bk.x, y: bk.y, w: bk.w, h: bk.h,
                pixels: ctx.getImageData(0, 0, bk.w, bk.h)
            };
        }
        return {
            playerX: this.player.x,
            playerCooldown: this.player.cooldown,
            invincible: this.invincible,
            firePressed: this.firePressed,
            score: this.score,
            lives: this.lives,
            wave: this.wave,
            frameCount: this.frameCount,
            aliens: alienSnap,
            alienDir: this.alienDir,
            alienSpeed: this.alienSpeed,
            alienMoveTimer: this.alienMoveTimer,
            alienMoveInterval: this.alienMoveInterval,
            animFrame: this.animFrame,
            bullets: bulletSnap,
            enemyBullets: ebSnap,
            bunkers: bunkerSnap,
            gameOver: this.gameOver,
            mystery: this.mystery ? { x: this.mystery.x, y: this.mystery.y, dir: this.mystery.dir } : null,
            enemyReloadTimer: this.enemyReloadTimer
        };
    };

    Game.prototype.restoreState = function (snap) {
        this.player.x = snap.playerX;
        this.player.cooldown = snap.playerCooldown;
        this.invincible = snap.invincible;
        this.firePressed = snap.firePressed;
        this.score = snap.score;
        this.lives = snap.lives;
        this.wave = snap.wave;
        this.frameCount = snap.frameCount;
        this.gameOver = snap.gameOver;
        this.alienDir = snap.alienDir;
        this.alienSpeed = snap.alienSpeed;
        this.alienMoveTimer = snap.alienMoveTimer;
        this.alienMoveInterval = snap.alienMoveInterval;
        this.animFrame = snap.animFrame;
        // Restore aliens
        for (var i = 0; i < snap.aliens.length; i++) {
            this.aliens[i].x = snap.aliens[i].x;
            this.aliens[i].y = snap.aliens[i].y;
            this.aliens[i].alive = snap.aliens[i].alive;
        }
        // Restore bullets (include w/h for collision detection)
        this.bullets = [];
        for (var i = 0; i < snap.bullets.length; i++) {
            this.bullets.push({ x: snap.bullets[i].x, y: snap.bullets[i].y, w: 3, h: 10 });
        }
        this.enemyBullets = [];
        for (var i = 0; i < snap.enemyBullets.length; i++) {
            this.enemyBullets.push({ x: snap.enemyBullets[i].x, y: snap.enemyBullets[i].y, w: 3, h: 10 });
        }
        // Restore bunkers
        for (var i = 0; i < snap.bunkers.length; i++) {
            var bk = this.bunkers[i];
            bk.x = snap.bunkers[i].x;
            bk.y = snap.bunkers[i].y;
            var ctx = bk.canvas.getContext('2d');
            ctx.putImageData(snap.bunkers[i].pixels, 0, 0);
        }
        // Restore mystery ship
        this.mystery = snap.mystery ? { x: snap.mystery.x, y: snap.mystery.y, dir: snap.mystery.dir } : null;
        this.enemyReloadTimer = snap.enemyReloadTimer || 0;
        // Clear transient state
        this.explosions = [];
        this.keys = {};
    };

    // Expose constants for external AI code
    Game.CANVAS_W = CANVAS_W;
    Game.CANVAS_H = CANVAS_H;
    Game.PLAYER_W = PLAYER_W;
    Game.PLAYER_H = PLAYER_H;
    Game.PLAYER_Y = PLAYER_Y;
    Game.ALIEN_ROWS = ALIEN_ROWS;
    Game.ALIEN_COLS = ALIEN_COLS;
    Game.NUM_ACTIONS = 6;
    Game.STATE_SIZE = 24;

    window.SpaceInvadersGame = Game;
})();
