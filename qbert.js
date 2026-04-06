// qbert.js — Q*bert game engine
// Pure game logic and simulation. No rendering, no AI.
// Used by dino-qbert.html, qbert-ai.js, and test-ai.js.
//
// Provides: constants, board utilities, level configuration,
// pathfinding, and frame-accurate simulation functions.
//
// Simulation functions operate on a state object (gs):
//   gs.player   = { row, col, jumping, jumpT, jumpDur, destRow, destCol, dead, deathTimer }
//   gs.enemies  = [{ type, row, col, jumping, jumpT, jumpDur, destRow, destCol,
//                    moveTimer, moveInterval, falling, willHatch, hops,
//                    timer, forcedType (spawn-timer only) }]
//   gs.cubes    = [{ row, col, state }]
//   gs.discs    = [{ active, side, row }]
//   gs.sm, gs.tgt, gs.lv, gs.cubesColored, gs.score, gs.alive,
//   gs.freezeTimer, gs.round, gs.levelWon

// ─── Simulation RNG ─────────────────────────────────────────────────────────
// AI simulations use a separate RNG so they don't pollute the game's Math.random sequence.
var simRng = Math.random;  // default: use Math.random (real game)

// Simple mulberry32 seeded PRNG for AI simulations
function createSeededRng(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// ─── Constants ───────────────────────────────────────────────────────────────
var ROWS = 7;
var DIRS = { UL: {dr:-1, dc:-1}, UR: {dr:-1, dc:0}, DL: {dr:1, dc:0}, DR: {dr:1, dc:1}, STAY: {dr:0, dc:0} };
var DIR_KEYS = ['UL', 'UR', 'DL', 'DR'];
var DIR_KEYS_WITH_STAY = ['UL', 'UR', 'DL', 'DR', 'STAY'];

// Frame timing (per-frame jumpT increments).
// Arcade MAME-verified: player hop-to-hop ~35f, enemy flight ~30f.
var PLAYER_JUMP_DUR = 1 / 35;   // 35 frames flight (arcade: 35f total cycle)
var ENEMY_JUMP_DUR  = 1 / 30;   // 30 frames flight + idle = arcade-accurate totals
// Arcade-accurate idle frames between hops (ROM verified).
// Total hop cycle = flight (~30 frames) + idle wait.
var BASE_ENEMY_INTERVALS = {
    egg: 12, coily: 16, redball: 12, greenball: 12, slick: 3, ugg: 12, wrongway: 12
};

// ─── Board utilities ─────────────────────────────────────────────────────────
function isValidPos(row, col) {
    return row >= 0 && row < ROWS && col >= 0 && col <= row;
}

function arcadeLevel(rnd) {
    var r = (rnd !== undefined) ? rnd : round;
    return Math.min(9, Math.ceil(r / 4));
}

function targetState(rnd) {
    var lv = arcadeLevel(rnd);
    return (lv === 1 || lv === 3) ? 1 : 2;
}

function nextCubeState(state, rnd) {
    var lv = arcadeLevel(rnd);
    var tgt = targetState(rnd);
    if (lv <= 2) return Math.min(state + 1, tgt);
    if (lv === 3) return state === 0 ? 1 : 0;
    if (lv === 4) return state === 2 ? 1 : state + 1;
    return (state + 1) % 3;
}

function levelSpeed(rnd) {
    var lv = arcadeLevel(rnd);
    return Math.min(2.0, 1.0 + (lv - 1) * 0.2);
}

function speedMultiplier(rnd) {
    // Speed slider no longer affects internal timing — it controls ticks/frame.
    // Only level-based speed scaling applies here.
    return levelSpeed(rnd);
}

function enemyMoveInterval(type, sm) {
    if (sm === undefined) sm = speedMultiplier();
    return Math.round((BASE_ENEMY_INTERVALS[type] || 30) / sm);
}

// ─── Level configuration ─────────────────────────────────────────────────────
function discCount(rnd) {
    var lv = arcadeLevel(rnd);
    var r = (((rnd !== undefined ? rnd : round) - 1) % 4);
    if (lv === 1) return 2;
    if (lv === 2) return [3, 3, 2, 2][r];
    if (lv === 3) return [4, 4, 3, 3][r];
    if (lv === 4) return [6, 6, 5, 4][r];
    if (lv === 5) return [7, 6, 5, 5][r];
    return 5; // levels 6-9: always 5 discs
}

function hasRedBall(rnd) {
    var r = (rnd !== undefined) ? rnd : round;
    if (r <= 2) return true;
    if (r === 3) return false;
    if (r >= 8) return true;
    var sub = ((r - 1) % 4) + 1;
    return sub === 1 || sub === 3 || sub === 4;
}
function hasUggWrongway(rnd) { return ((rnd !== undefined) ? rnd : round) >= 3; }
function hasSlick(rnd) { return ((rnd !== undefined) ? rnd : round) >= 4; }
function hasGreenBall(rnd) { return ((rnd !== undefined) ? rnd : round) >= 6; }

// Arcade-accurate disc positions per level and sub-round.
// Notation: {side: 0=left 1=right, row: 0-indexed from apex}.
// Source: verified against arcade gameplay.
var DISC_TABLE = [
    // Level 1: 2 discs per round
    [[{side:0,row:4},{side:1,row:4}],
     [{side:0,row:5},{side:1,row:6}],
     [{side:0,row:3},{side:1,row:5}],
     [{side:0,row:0},{side:1,row:6}]],
    // Level 2: 3,3,2,2 discs
    [[{side:0,row:3},{side:1,row:0},{side:1,row:4}],
     [{side:0,row:5},{side:1,row:0},{side:1,row:5}],
     [{side:0,row:2},{side:1,row:5}],
     [{side:0,row:1},{side:1,row:3}]],
    // Level 3: 4,4,3,3 discs
    [[{side:0,row:2},{side:0,row:4},{side:1,row:2},{side:1,row:3}],
     [{side:0,row:2},{side:0,row:3},{side:1,row:3},{side:1,row:5}],
     [{side:0,row:0},{side:0,row:2},{side:1,row:4}],
     [{side:1,row:1},{side:1,row:4},{side:1,row:6}]],
    // Level 4: 6,6,5,4 discs
    [[{side:0,row:0},{side:0,row:3},{side:0,row:5},{side:1,row:1},{side:1,row:5},{side:1,row:6}],
     [{side:0,row:0},{side:0,row:4},{side:0,row:5},{side:1,row:1},{side:1,row:5},{side:1,row:6}],
     [{side:0,row:2},{side:0,row:4},{side:1,row:1},{side:1,row:2},{side:1,row:4}],
     [{side:0,row:0},{side:0,row:1},{side:1,row:3},{side:1,row:6}]],
    // Level 5: 7,6,5,5 discs
    [[{side:0,row:0},{side:0,row:1},{side:0,row:3},{side:0,row:5},{side:1,row:0},{side:1,row:2},{side:1,row:6}],
     [{side:0,row:0},{side:0,row:4},{side:0,row:5},{side:1,row:1},{side:1,row:3},{side:1,row:4}],
     [{side:0,row:2},{side:0,row:4},{side:1,row:2},{side:1,row:3},{side:1,row:6}],
     [{side:0,row:2},{side:0,row:4},{side:1,row:2},{side:1,row:3},{side:1,row:6}]]
    // Levels 6-9: same as level 5 round 4 (5 discs)
];

function discConfig(rnd) {
    var r = (rnd !== undefined) ? rnd : round;
    var lv = arcadeLevel(rnd);
    var ri = ((r - 1) % 4);
    var tableIdx = Math.min(lv, 5) - 1;
    var roundDiscs = DISC_TABLE[tableIdx][ri];
    var result = [];
    for (var i = 0; i < roundDiscs.length; i++)
        result.push({side: roundDiscs[i].side, row: roundDiscs[i].row, active: true});
    return result;
}

function roundCompletionBonus(rnd) {
    var r = (rnd !== undefined) ? rnd : round;
    var lv = arcadeLevel(r);
    return Math.min(5000, 750 + 1000 * lv + 250 * r);
}

function unusedDiscBonus(dsList) {
    var ds = dsList || (typeof discs !== 'undefined' ? discs : []);
    var count = 0;
    for (var i = 0; i < ds.length; i++)
        if (ds[i].active) count++;
    return count * 50;
}

// Global-accessor convenience functions (for HTML game loop using globals)
function cubeAt(row, col) {
    for (var i = 0; i < cubeStates.length; i++)
        if (cubeStates[i].row === row && cubeStates[i].col === col) return cubeStates[i];
    return null;
}

function allColored() {
    var tgt = targetState();
    for (var i = 0; i < cubeStates.length; i++)
        if (cubeStates[i].state < tgt) return false;
    return true;
}

// Get effective position of an enemy (destination if mid-jump pre-apex)
function enemyEffectivePos(e) {
    if (e.destRow != null && e.destCol != null) {
        return { row: e.destRow, col: e.destCol };
    }
    return { row: e.row, col: e.col };
}

// ─── BFS pathfinding ─────────────────────────────────────────────────────────
function bfsTo(r1, c1, r2, c2, avoidSet) {
    if (r1 === r2 && c1 === c2) return { dist: 0, path: [] };
    var visited = {}; visited[r1 + ',' + c1] = true;
    var queue = [{ row: r1, col: c1, path: [] }];
    while (queue.length > 0) {
        var cur = queue.shift();
        for (var k = 0; k < DIR_KEYS.length; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = cur.row + dk.dr, nc = cur.col + dk.dc;
            if (!isValidPos(nr, nc)) continue;
            var key = nr + ',' + nc;
            if (visited[key]) continue;
            if (avoidSet && avoidSet[key]) continue;
            visited[key] = true;
            var np = cur.path.concat([DIR_KEYS[k]]);
            if (nr === r2 && nc === c2) return { dist: np.length, path: np };
            queue.push({ row: nr, col: nc, path: np });
        }
    }
    return null;
}

function boardSig(cubes) {
    var cs = cubes || (typeof cubeStates !== 'undefined' ? cubeStates : []);
    var s = '';
    for (var i = 0; i < cs.length; i++) s += cs[i].state;
    return s;
}

// ─── Precomputed pairwise BFS distances ──────────────────────────────────────
var bfsDistTable = {};
(function buildDistTable() {
    var positions = [];
    for (var r = 0; r < ROWS; r++)
        for (var c = 0; c <= r; c++)
            positions.push({ r: r, c: c });
    for (var i = 0; i < positions.length; i++) {
        var src = positions[i];
        var key0 = src.r + ',' + src.c;
        var dist = {}; dist[key0] = 0;
        var queue = [src];
        while (queue.length > 0) {
            var cur = queue.shift();
            var cd = dist[cur.r + ',' + cur.c];
            for (var k = 0; k < 4; k++) {
                var dk = DIRS[DIR_KEYS[k]];
                var nr = cur.r + dk.dr, nc = cur.c + dk.dc;
                if (!isValidPos(nr, nc)) continue;
                var nk = nr + ',' + nc;
                if (dist[nk] !== undefined) continue;
                dist[nk] = cd + 1;
                queue.push({ r: nr, c: nc });
            }
        }
        bfsDistTable[key0] = dist;
    }
})();

function exBfsDist(r1, c1, r2, c2) {
    var d = bfsDistTable[r1 + ',' + c1];
    return d ? (d[r2 + ',' + c2] || 99) : 99;
}

// ─── Position indexing ───────────────────────────────────────────────────────
var POS_COUNT = ROWS * (ROWS + 1) / 2; // 28
var posToIdx = [];
var idxToPos = [];
(function() {
    for (var i = 0; i < ROWS * ROWS; i++) posToIdx.push(-1);
    var idx = 0;
    for (var r = 0; r < ROWS; r++)
        for (var c = 0; c <= r; c++) {
            posToIdx[r * ROWS + c] = idx;
            idxToPos.push([r, c]);
            idx++;
        }
})();

var distMatrix = new Int8Array(POS_COUNT * POS_COUNT);
(function() {
    for (var i = 0; i < POS_COUNT; i++)
        for (var j = 0; j < POS_COUNT; j++)
            distMatrix[i * POS_COUNT + j] = exBfsDist(idxToPos[i][0], idxToPos[i][1],
                                                       idxToPos[j][0], idxToPos[j][1]);
})();

var posAdj = [];
(function() {
    for (var i = 0; i < POS_COUNT; i++) {
        var adj = [];
        var r = idxToPos[i][0], c = idxToPos[i][1];
        for (var k = 0; k < 4; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var nr = r + dk.dr, nc = c + dk.dc;
            if (isValidPos(nr, nc)) adj.push(posToIdx[nr * ROWS + nc]);
        }
        posAdj.push(adj);
    }
})();

// ─── Game state creation ─────────────────────────────────────────────────────

// Create a fresh round state
function simCreateRoundState(rnd) {
    var sm = speedMultiplier(rnd);
    var tgt = targetState(rnd);
    var lv = arcadeLevel(rnd);

    var cubes = [];
    for (var r = 0; r < ROWS; r++)
        for (var c = 0; c <= r; c++)
            cubes.push({ row: r, col: c, state: 0 });

    var p = {
        row: 0, col: 0, dead: false, deathTimer: 0,
        jumping: false, jumpT: 0,
        jumpDur: PLAYER_JUMP_DUR * sm,
        destRow: null, destCol: null
    };

    var dc = discConfig(rnd);
    var ds = [];
    for (var i = 0; i < dc.length; i++)
        ds.push({ side: dc[i].side, row: dc[i].row, active: true });

    return {
        player: p,
        enemies: [],
        cubes: cubes,
        discs: ds,
        sm: sm,
        tgt: tgt,
        lv: lv,
        cubesColored: 0,
        score: 0,
        alive: true,
        freezeTimer: 0,
        round: rnd,
        levelWon: false
    };
}

// Schedule a spawn timer
function simScheduleSpawn(gs, delay, forcedType) {
    gs.enemies.push({ type: 'spawn-timer', timer: delay, forcedType: forcedType || null });
}

// Schedule initial enemies for a round
function simScheduleInitialEnemies(gs) {
    var rnd = gs.round;
    var lv = arcadeLevel(rnd);
    simScheduleSpawn(gs, 180);                                           // Coily egg
    if (hasRedBall(rnd))     simScheduleSpawn(gs, 300, 'redball');
    if (hasSlick(rnd))       simScheduleSpawn(gs, 900, 'slick');
    if (hasGreenBall(rnd))   simScheduleSpawn(gs, 540, 'greenball');
    if (hasUggWrongway(rnd)) simScheduleSpawn(gs, 660, 'ugg');
    if (hasUggWrongway(rnd)) simScheduleSpawn(gs, 780, 'wrongway');
    if (lv >= 3 && hasRedBall(rnd)) simScheduleSpawn(gs, 600, 'redball');
    if (lv >= 4 && hasSlick(rnd))   simScheduleSpawn(gs, 1080, 'slick');
}

// Schedule respawn enemies after death
function simScheduleRespawnEnemies(gs) {
    var rnd = gs.round;
    simScheduleSpawn(gs, 180);                                           // Coily egg
    if (hasRedBall(rnd))     simScheduleSpawn(gs, Math.max(120, 240 - Math.floor(rnd / 2) * 15), 'redball');
    if (hasSlick(rnd))       simScheduleSpawn(gs, 720, 'slick');
    if (hasGreenBall(rnd))   simScheduleSpawn(gs, 540, 'greenball');  // was 480
    if (hasUggWrongway(rnd)) simScheduleSpawn(gs, 540, 'ugg');
    if (hasUggWrongway(rnd)) simScheduleSpawn(gs, 600, 'wrongway');   // was 660
}

// Spawn an enemy into the game state
function simSpawnEnemy(gs, forcedType) {
    var type = forcedType;
    if (!type) {
        var hasCoily = false;
        for (var i = 0; i < gs.enemies.length; i++)
            if (gs.enemies[i].type === 'coily' || gs.enemies[i].type === 'egg') { hasCoily = true; break; }
        type = hasCoily ? 'redball' : 'egg';
    }
    var spawnCol = Math.floor(simRng() * 2);
    var interval = enemyMoveInterval(type, gs.sm);
    // Arcade: enemies drop in from off-screen before becoming active.
    // spawnAnimTimer counts down during drop-in; enemy is visible but not collidable.
    var spawnAnim = 20; // ~20 frames of drop-in animation
    if (type === 'ugg') {
        gs.enemies.push({ type: 'ugg', row: ROWS-1, col: ROWS-1,
            jumping: false, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * gs.sm,
            moveTimer: 0, moveInterval: interval, destRow: null, destCol: null,
            spawnAnimTimer: spawnAnim });
    } else if (type === 'wrongway') {
        gs.enemies.push({ type: 'wrongway', row: ROWS-1, col: 0,
            jumping: false, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * gs.sm,
            moveTimer: 0, moveInterval: interval, destRow: null, destCol: null,
            spawnAnimTimer: spawnAnim });
    } else {
        // ROM $B506: balls get a 7-bit random direction path at spawn
        var dirBits = (type === 'redball' || type === 'greenball' || type === 'slick')
            ? Math.floor(simRng() * 128) : undefined;
        gs.enemies.push({ type: type, row: 1, col: spawnCol, hops: 0,
            jumping: false, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * gs.sm,
            moveTimer: 0, moveInterval: interval, destRow: null, destCol: null,
            dirBits: dirBits, spawnAnimTimer: spawnAnim });
    }
}

// ─── Simulation: frame-level updates ─────────────────────────────────────────

function simEnemyJumpTo(e, nr, nc, sm) {
    e.jumpSrcRow = e.row;
    e.jumpSrcCol = e.col;
    e.jumping = true;
    e.jumpT = 0;
    e.jumpDur = ENEMY_JUMP_DUR * sm;
    e.destRow = nr;
    e.destCol = nc;
}

// Stomp a cube at position (updates cube state and cubesColored)
function simStompCube(gs, row, col) {
    if (gs.survivalOnly) return; // skip cube modification during expectimax
    for (var i = 0; i < gs.cubes.length; i++) {
        if (gs.cubes[i].row === row && gs.cubes[i].col === col) {
            var cube = gs.cubes[i];
            var next = nextCubeState(cube.state, gs.round);
            if (next !== cube.state) {
                var oldC = Math.min(cube.state, gs.tgt);
                cube.state = next;
                var newC = Math.min(cube.state, gs.tgt);
                gs.cubesColored += newC - oldC;
                if (newC > oldC) gs.score += (cube.state === gs.tgt) ? 25 : 15;
            }
            return;
        }
    }
}

// Check if all cubes are at target state
function simAllColored(gs) {
    return gs.cubesColored >= gs.cubes.length * gs.tgt;
}

// Schedule respawn for a fallen enemy
function simScheduleEnemyRespawn(gs, type) {
    var rnd = gs.round;
    if (type === 'egg' || type === 'coily') simScheduleSpawn(gs, 180);
    else if (type === 'redball' && hasRedBall(rnd))
        simScheduleSpawn(gs, Math.max(120, 240 - Math.floor(rnd / 2) * 15), 'redball');
    else if (type === 'greenball' && hasGreenBall(rnd)) simScheduleSpawn(gs, 540, 'greenball');
    else if (type === 'slick' && hasSlick(rnd)) simScheduleSpawn(gs, 720, 'slick');
    else if (type === 'ugg' && hasUggWrongway(rnd)) simScheduleSpawn(gs, 540, 'ugg');
    else if (type === 'wrongway' && hasUggWrongway(rnd)) simScheduleSpawn(gs, 600, 'wrongway');
}

// Update player for one frame. Returns 'landed' if player just finished jumping.
function simUpdatePlayer(gs) {
    if (gs.player.dead) {
        gs.player.deathTimer--;
        return gs.player.deathTimer <= 0 ? 'respawn' : 'dead';
    }
    if (!gs.player.jumping) return null;

    gs.player.jumpT += gs.player.jumpDur;
    if (gs.player.jumpT >= 1) {
        gs.player.jumpT = 1;
        gs.player.jumping = false;
        gs.player.row = gs.player.destRow;
        gs.player.col = gs.player.destCol;
        gs.player.destRow = null;
        gs.player.destCol = null;
        return 'landed';
    }
    return null;
}

// Update all enemies for one frame
function simUpdateEnemies(gs) {
    // Tick spawn timers
    for (var i = gs.enemies.length - 1; i >= 0; i--) {
        if (gs.enemies[i].type === 'spawn-timer') {
            gs.enemies[i].timer--;
            if (gs.enemies[i].timer <= 0) {
                var ft = gs.enemies[i].forcedType;
                gs.enemies.splice(i, 1);
                simSpawnEnemy(gs, ft);
            }
        }
    }

    // Freeze check
    if (gs.freezeTimer > 0) { gs.freezeTimer--; return; }

    for (var i = gs.enemies.length - 1; i >= 0; i--) {
        var e = gs.enemies[i];
        if (e.type === 'spawn-timer') continue;

        // Drop-in animation: enemy is visible but not active yet
        if (e.spawnAnimTimer > 0) { e.spawnAnimTimer--; continue; }

        // Jump animation
        if (e.jumping) {
            e.jumpT += e.jumpDur;
            if (e.jumpT >= 1) {
                e.jumpT = 1; e.jumping = false;
                e.row = e.destRow; e.col = e.destCol;
                e.destRow = null; e.destCol = null;
                // Fell off
                if (e.falling) {
                    // Coily lured off by disc: 500 points, clear all enemies, respawn
                    if (e.type === 'coily' && e.lureRow != null) {
                        gs.score += 500;
                        var spawnTimers = [];
                        for (var j = 0; j < gs.enemies.length; j++)
                            if (gs.enemies[j].type === 'spawn-timer') spawnTimers.push(gs.enemies[j]);
                        gs.enemies = spawnTimers;
                        simScheduleSpawn(gs, 180);
                        break; // enemies array replaced, exit loop
                    }
                    var ft = e.type;
                    gs.enemies.splice(i, 1);
                    simScheduleEnemyRespawn(gs, ft);
                    continue;
                }
                // Egg hatches into Coily
                if (e.willHatch) {
                    e.willHatch = false;
                    e.type = 'coily';
                    e.moveInterval = enemyMoveInterval('coily', gs.sm);
                    e.spawnAnimTimer = 0; // hatched Coily is immediately active
                }
                // Slick reverts cube on landing
                if (e.type === 'slick') {
                    for (var ci = 0; ci < gs.cubes.length; ci++) {
                        if (gs.cubes[ci].row === e.row && gs.cubes[ci].col === e.col) {
                            if (gs.cubes[ci].state > 0) {
                                var oldC = Math.min(gs.cubes[ci].state, gs.tgt);
                                gs.cubes[ci].state--;
                                var newC = Math.min(gs.cubes[ci].state, gs.tgt);
                                gs.cubesColored += newC - oldC;
                            }
                            break;
                        }
                    }
                    if (e.row >= ROWS - 1) {
                        gs.enemies.splice(i, 1);
                        if (hasSlick(gs.round)) simScheduleSpawn(gs, 720, 'slick');
                        continue;
                    }
                }
            }
            continue; // don't tick move timer while jumping
        }

        // Idle: tick move timer
        e.moveTimer++;
        if (e.moveTimer < e.moveInterval) continue;
        e.moveTimer = 0;

        // Execute move by type
        if (e.type === 'egg') {
            var dir = simHopDecision() < 0.5 ? 'DL' : 'DR';
            var delta = DIRS[dir];
            var nr = e.row + delta.dr, nc = e.col + delta.dc;
            e.hops = (e.hops || 0) + 1;
            simEnemyJumpTo(e, nr, nc, gs.sm);
            if (!isValidPos(nr, nc)) e.falling = true;
            else if (e.hops >= 6 || nr >= ROWS - 1) e.willHatch = true;
        } else if (e.type === 'coily') {
            // ROM $B6EA: Coily chases Q*bert's PREVIOUS position.
            // Exception: if Coily IS at previous, chase CURRENT.
            var hasLure = e.lureRow != null;
            var targetR, targetC;
            if (hasLure) {
                targetR = e.lureRow; targetC = e.lureCol;
            } else {
                var prevR = gs.player.prevRow != null ? gs.player.prevRow : gs.player.row;
                var prevC = gs.player.prevCol != null ? gs.player.prevCol : gs.player.col;
                if (e.row === prevR && e.col === prevC) {
                    targetR = gs.player.row; targetC = gs.player.col;
                } else {
                    targetR = prevR; targetC = prevC;
                }
            }
            // Grid word comparison (ROM algorithm):
            // gw1 = row - col + 1; compare rows then gw1 values
            var c_gw1 = e.row - e.col + 1;
            var t_gw1 = targetR - targetC + 1;
            var enr, enc;
            if (targetR > e.row) { // target below → go DOWN
                if (t_gw1 > c_gw1) { enr = e.row + 1; enc = e.col; }     // DOWN-LEFT
                else                { enr = e.row + 1; enc = e.col + 1; } // DOWN-RIGHT
            } else {               // target above or same → go UP
                if (t_gw1 < c_gw1) { enr = e.row - 1; enc = e.col; }     // UP-RIGHT
                else                { enr = e.row - 1; enc = e.col - 1; } // UP-LEFT
            }
            // When lured and on the disc's row, allow jumping off the edge
            var canExit = hasLure && e.row === e.lureRow;
            if (!canExit && !isValidPos(enr, enc)) {
                e.falling = true;
            }
            simEnemyJumpTo(e, enr, enc, gs.sm);
            if (!isValidPos(enr, enc)) e.falling = true;
        } else if (e.type === 'redball' || e.type === 'greenball' || e.type === 'slick') {
            // ROM $B506: Ball path is predetermined by 7-bit direction_bits at spawn.
            // Each hop: consume bit 0 (shift right). 1=DR, 0=DL.
            var nr, nc;
            if (e.dirBits != null) {
                if (e.dirBits & 1) { nr = e.row + 1; nc = e.col + 1; } // DR
                else               { nr = e.row + 1; nc = e.col; }     // DL
                e.dirBits >>= 1;
            } else {
                // Fallback for legacy: random per hop
                var dir = simHopDecision() < 0.5 ? 'DL' : 'DR';
                var delta = DIRS[dir];
                nr = e.row + delta.dr; nc = e.col + delta.dc;
            }
            simEnemyJumpTo(e, nr, nc, gs.sm);
            if (!isValidPos(nr, nc)) e.falling = true;
        } else if (e.type === 'ugg') {
            var udir = simHopDecision() < 0.5;
            var unr = udir ? e.row - 1 : e.row;
            var unc = e.col - 1;
            simEnemyJumpTo(e, unr, unc, gs.sm);
            if (!isValidPos(unr, unc)) e.falling = true;
        } else if (e.type === 'wrongway') {
            // On-grid approximation of arcade off-grid left-face crawling.
            // Arcade: always col+1 (from col=-1 toward edge). On-grid: stay
            // at col=0 when going up to remain a left-edge threat (symmetric with Ugg).
            var wdir = simHopDecision() < 0.5;
            var wnr = wdir ? e.row - 1 : e.row;
            var wnc = wdir ? e.col : e.col + 1;
            simEnemyJumpTo(e, wnr, wnc, gs.sm);
            if (!isValidPos(wnr, wnc)) e.falling = true;
        }
    }
}

// Get the tile an entity is "on" for collision purposes.
// During a jump: first 1/3 on source, middle 1/3 immune, last 1/3 on dest.
function collisionTile(entity) {
    if (!entity.jumping) return { row: entity.row, col: entity.col };
    if (entity.jumpT < 0.33) return { row: entity.row, col: entity.col };
    if (entity.jumpT >= 0.67) return { row: entity.destRow, col: entity.destCol };
    return null; // immune at apex
}

// Per-frame collision check: same tile = death (or catch for slick/greenball)
// During freeze, enemies are harmless (can still catch slick/greenball).
function simCheckCollision(gs) {
    if (gs.player.dead) return;
    var pt = collisionTile(gs.player);
    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type === 'spawn-timer') continue;
        if (e.spawnAnimTimer > 0) continue; // dropping in, not active yet
        // Cross-path collision (ROM $BD1E): entities swapping positions mid-jump.
        // Checked BEFORE tile immunity — swap kills even during immune zone.
        var hit = false;
        if (gs.player.jumping && e.jumping &&
            gs.player.destRow != null && e.destRow != null &&
            gs.player.jumpSrcRow != null && e.jumpSrcRow != null &&
            gs.player.destRow === e.jumpSrcRow && gs.player.destCol === e.jumpSrcCol &&
            gs.player.jumpSrcRow === e.destRow && gs.player.jumpSrcCol === e.destCol) {
            hit = true;
        }
        // Same-tile collision (skip if player or enemy immune)
        if (!hit) {
            if (!pt) continue; // player immune at apex
            var et = collisionTile(e);
            if (!et) continue; // enemy immune at apex
            if (et.row === pt.row && et.col === pt.col) hit = true;
        }
        if (hit) {
            if (e.type === 'slick') {
                gs.score += 300;
                gs.enemies.splice(i, 1); i--;
            } else if (e.type === 'greenball') {
                gs.score += 100;
                gs.freezeTimer = 300;
                gs.enemies.splice(i, 1); i--;
            } else if (gs.freezeTimer > 0) {
                // Enemies are frozen and harmless — skip lethal collision
                continue;
            } else {
                gs.alive = false;
                gs.player.dead = true;
                gs.deathEnemy = e.type;
                return;
            }
        }
    }
}

// Use a disc (player rides to top, Coily chases the disc position)
// Player stays at disc position (off-grid) during the ride — caller
// must move player to (0,0) and stomp when the ride finishes.
function simUseDisc(gs, idx) {
    var disc = gs.discs[idx];
    disc.active = false;
    // Track even-row disc usage for L5+ parity
    if (disc.row % 2 === 0) gs.evenRowDiscs = (gs.evenRowDiscs || 0) + 1;
    // Set lure on Coily — it will chase toward the disc exit and fall off naturally
    // Left side lure: col -1 (off left edge). Right side lure: col disc.row
    // (the rightmost valid column on that row, so UR takes Coily off the grid).
    var lureRow = disc.row;
    var lureCol = disc.side === 0 ? -1 : disc.row + 1;
    for (var i = 0; i < gs.enemies.length; i++) {
        if (gs.enemies[i].type === 'coily') {
            gs.enemies[i].lureRow = lureRow;
            gs.enemies[i].lureCol = lureCol;
        }
    }
    // Player is at the disc position (off-grid, immune from collisions)
    gs.player.row = disc.row;
    gs.player.col = disc.side === 0 ? -1 : disc.row + 1;
    gs.player.jumping = false;
}

// Try to move the player in a direction. Returns true if move started.
// Returns 'disc' if a disc was used.
function simTryMove(gs, dirKey) {
    if (gs.player.dead || gs.player.jumping) return false;
    var d = DIRS[dirKey]; if (!d) return false;
    var nr = gs.player.row + d.dr, nc = gs.player.col + d.dc;

    // ROM: grid words update at hop trigger — set previous position for ALL moves
    // (including disc use, so Coily chases correctly after disc rides)
    gs.player.prevRow = gs.player.row;
    gs.player.prevCol = gs.player.col;

    if (!isValidPos(nr, nc)) {
        // Check for disc
        for (var di = 0; di < gs.discs.length; di++) {
            var disc = gs.discs[di];
            if (!disc.active) continue;
            var isLeft = (disc.side === 0 && dirKey === 'UL' && gs.player.col === 0 && gs.player.row === disc.row);
            var isRight = (disc.side === 1 && dirKey === 'UR' && gs.player.col === gs.player.row && gs.player.row === disc.row);
            if (isLeft || isRight) {
                simUseDisc(gs, di);
                return 'disc';
            }
        }
        // Fall off edge
        gs.alive = false;
        gs.player.dead = true;
        gs.deathEnemy = 'fall';
        // Track odd-row falls for L5+ parity
        if (gs.player.row % 2 === 1) gs.oddRowFalls = (gs.oddRowFalls || 0) + 1;
        return false;
    }

    gs.player.jumpSrcRow = gs.player.row;
    gs.player.jumpSrcCol = gs.player.col;
    gs.player.jumping = true;
    gs.player.jumpT = 0;
    gs.player.jumpDur = PLAYER_JUMP_DUR * gs.sm;
    gs.player.destRow = nr;
    gs.player.destCol = nc;
    return true;
}

// ─── High-level simulation ───────────────────────────────────────────────────

// Deep clone a game state for AI search
function simDeepClone(gs) {
    var cubes = new Array(gs.cubes.length);
    for (var i = 0; i < gs.cubes.length; i++)
        cubes[i] = { row: gs.cubes[i].row, col: gs.cubes[i].col, state: gs.cubes[i].state };

    var ens = new Array(gs.enemies.length);
    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type === 'spawn-timer') {
            ens[i] = { type: 'spawn-timer', timer: e.timer, forcedType: e.forcedType };
        } else {
            ens[i] = { type: e.type, row: e.row, col: e.col,
                       jumping: e.jumping, jumpT: e.jumpT, jumpDur: e.jumpDur,
                       destRow: e.destRow, destCol: e.destCol,
                       jumpSrcRow: e.jumpSrcRow, jumpSrcCol: e.jumpSrcCol,
                       moveTimer: e.moveTimer, moveInterval: e.moveInterval,
                       falling: e.falling || false, willHatch: e.willHatch || false,
                       hops: e.hops || 0,
                       spawnAnimTimer: e.spawnAnimTimer || 0 };
            if (e.dirBits != null) ens[i].dirBits = e.dirBits;
            if (e.lureRow != null) { ens[i].lureRow = e.lureRow; ens[i].lureCol = e.lureCol; }
        }
    }

    var ds = new Array(gs.discs.length);
    for (var i = 0; i < gs.discs.length; i++)
        ds[i] = { side: gs.discs[i].side, row: gs.discs[i].row, active: gs.discs[i].active };

    return {
        player: { row: gs.player.row, col: gs.player.col,
                  prevRow: gs.player.prevRow, prevCol: gs.player.prevCol,
                  dead: gs.player.dead, deathTimer: gs.player.deathTimer || 0,
                  jumping: gs.player.jumping, jumpT: gs.player.jumpT,
                  jumpDur: gs.player.jumpDur,
                  jumpSrcRow: gs.player.jumpSrcRow, jumpSrcCol: gs.player.jumpSrcCol,
                  destRow: gs.player.destRow, destCol: gs.player.destCol },
        enemies: ens,
        cubes: cubes,
        discs: ds,
        sm: gs.sm, tgt: gs.tgt, lv: gs.lv,
        cubesColored: gs.cubesColored,
        score: gs.score,
        alive: gs.alive,
        freezeTimer: gs.freezeTimer,
        round: gs.round,
        levelWon: gs.levelWon || false
    };
}

// ─── Fast survival-only simStep ──────────────────────────────────────────────
// Optimized for expectimax: inlined collision checks (no object allocation),
// no cube/score modifications, no splice (dead enemies skipped).
// Returns true if player survived, false if died.

function simStepSurvival(gs, dir) {
    var p = gs.player, sm = gs.sm;
    var pJumpDur = PLAYER_JUMP_DUR * sm;
    var eJumpDur = ENEMY_JUMP_DUR * sm;

    // --- STAY: advance enemies, check collision ---
    if (dir === 'STAY') {
        var maxWait = Math.ceil(1.0 / pJumpDur) + 8;
        for (var f = 0; f < maxWait; f++) {
            simUpdateEnemies(gs);
            if (_simCheckFast(gs)) return false;
        }
        return true;
    }

    // --- Pre-move collision ---
    if (_simCheckFast(gs)) return false;

    // --- Try move ---
    var d = DIRS[dir];
    var nr = p.row + d.dr, nc = p.col + d.dc;
    var validDest = (nr >= 0 && nr < ROWS && nc >= 0 && nc <= nr);

    if (!validDest) {
        // Disc check
        for (var di = 0; di < gs.discs.length; di++) {
            var disc = gs.discs[di];
            if (!disc.active) continue;
            var isLeft = (disc.side === 0 && dir === 'UL' && p.col === 0 && p.row === disc.row);
            var isRight = (disc.side === 1 && dir === 'UR' && p.col === p.row && p.row === disc.row);
            if (isLeft || isRight) {
                // Disc ride
                disc.active = false;
                var lureRow = disc.row;
                var lureCol = disc.side === 0 ? -1 : disc.row + 1;
                for (var ei = 0; ei < gs.enemies.length; ei++)
                    if (gs.enemies[ei].type === 'coily') {
                        gs.enemies[ei].lureRow = lureRow; gs.enemies[ei].lureCol = lureCol;
                    }
                p.row = disc.row; p.col = disc.side === 0 ? -1 : disc.row + 1;
                p.jumping = false;
                for (var f = 0; f < 30; f++) simUpdateEnemies(gs);
                p.row = 0; p.col = 0;
                return !_simCheckFast(gs);
            }
        }
        // Fall off
        gs.alive = false;
        return false;
    }

    // --- Normal hop ---
    p.prevRow = p.row; p.prevCol = p.col;
    p.jumpSrcRow = p.row; p.jumpSrcCol = p.col;
    p.jumping = true; p.jumpT = 0; p.jumpDur = pJumpDur;
    p.destRow = nr; p.destCol = nc;

    // Frame loop — pre-computed count
    var frames = Math.ceil(1.0 / pJumpDur);
    for (var f = 0; f < frames; f++) {
        p.jumpT += pJumpDur;
        if (p.jumpT >= 1) {
            p.jumpT = 1; p.jumping = false;
            p.row = nr; p.col = nc; p.destRow = null; p.destCol = null;
        }
        simUpdateEnemies(gs);
        if (!gs.alive) return false;
        if (_simCheckFast(gs)) return false;
    }
    // Idle frame
    simUpdateEnemies(gs);
    if (_simCheckFast(gs)) return false;
    return true;
}

// Inlined collision check — no object allocation, returns true if player dies
function _simCheckFast(gs) {
    var p = gs.player;
    // Player collision tile (inlined)
    var ptR, ptC, pImmune = false;
    if (p.jumping) {
        if (p.jumpT < 0.33) { ptR = p.row; ptC = p.col; }
        else if (p.jumpT >= 0.67) { ptR = p.destRow; ptC = p.destCol; }
        else { pImmune = true; } // immune at apex (but cross-path still checked)
    } else {
        ptR = p.row; ptC = p.col;
    }
    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type === 'spawn-timer' || e.spawnAnimTimer > 0) continue;
        // Cross-path collision: checked even during immune zone
        var hit = false;
        if (p.jumping && e.jumping &&
            p.destRow === e.jumpSrcRow && p.destCol === e.jumpSrcCol &&
            p.jumpSrcRow === e.destRow && p.jumpSrcCol === e.destCol) {
            hit = true;
        }
        // Same-tile collision (skip if player or enemy immune)
        if (!hit && !pImmune) {
            var etR, etC;
            if (e.jumping) {
                if (e.jumpT < 0.33) { etR = e.row; etC = e.col; }
                else if (e.jumpT >= 0.67) { etR = e.destRow; etC = e.destCol; }
                else continue; // enemy immune
            } else {
                etR = e.row; etC = e.col;
            }
            if (etR === ptR && etC === ptC) hit = true;
        }
        if (hit) {
            if (e.type === 'slick') continue; // harmless
            if (e.type === 'greenball') { gs.freezeTimer = 300; gs.enemies.splice(i, 1); i--; continue; }
            if (gs.freezeTimer > 0) continue; // frozen = harmless
            gs.alive = false; p.dead = true;
            return true;
        }
    }
    return false;
}

// Fast clone for survival evaluation: shares cubes (read-only for survival),
// only clones player + enemies + discs. ~3x faster than simDeepClone.
function simSurvivalClone(gs) {
    var ens = new Array(gs.enemies.length);
    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type === 'spawn-timer') {
            ens[i] = { type: 'spawn-timer', timer: e.timer, forcedType: e.forcedType };
        } else {
            ens[i] = { type: e.type, row: e.row, col: e.col,
                       jumping: e.jumping, jumpT: e.jumpT, jumpDur: e.jumpDur,
                       destRow: e.destRow, destCol: e.destCol,
                       jumpSrcRow: e.jumpSrcRow, jumpSrcCol: e.jumpSrcCol,
                       moveTimer: e.moveTimer, moveInterval: e.moveInterval,
                       falling: e.falling || false, willHatch: e.willHatch || false,
                       hops: e.hops || 0,
                       spawnAnimTimer: e.spawnAnimTimer || 0 };
            if (e.dirBits != null) ens[i].dirBits = e.dirBits;
            if (e.lureRow != null) { ens[i].lureRow = e.lureRow; ens[i].lureCol = e.lureCol; }
        }
    }
    var ds = new Array(gs.discs.length);
    for (var i = 0; i < gs.discs.length; i++)
        ds[i] = { side: gs.discs[i].side, row: gs.discs[i].row, active: gs.discs[i].active };
    return {
        player: { row: gs.player.row, col: gs.player.col,
                  prevRow: gs.player.prevRow, prevCol: gs.player.prevCol,
                  dead: false, deathTimer: 0,
                  jumping: false, jumpT: 0,
                  jumpDur: gs.player.jumpDur,
                  jumpSrcRow: null, jumpSrcCol: null,
                  destRow: null, destCol: null },
        enemies: ens,
        cubes: gs.cubes, // shared — simStompCube skips when survivalOnly=true
        discs: ds,
        sm: gs.sm, tgt: gs.tgt, lv: gs.lv,
        cubesColored: gs.cubesColored,
        score: gs.score,
        alive: true,
        freezeTimer: gs.freezeTimer,
        round: gs.round,
        levelWon: false,
        survivalOnly: true
    };
}

// Simulate one complete player hop (start jump → frames until landing).
// Returns true if player survived, false if died.
function simStep(gs, dir) {
    if (dir === 'STAY') {
        // Advance enemies until the nearest Coily completes its current jump
        // and starts its next one. This models waiting for the right moment.
        var coilyLanded = false;
        var maxWait = Math.ceil(1.0 / (gs.player.jumpDur || PLAYER_JUMP_DUR)) + 8;
        for (var f = 0; f < maxWait; f++) {
            // Check if any Coily just landed this frame
            var anyCoilyJumping = false;
            for (var ei = 0; ei < gs.enemies.length; ei++) {
                if (gs.enemies[ei].type === 'coily' && gs.enemies[ei].jumping) anyCoilyJumping = true;
            }
            simUpdateEnemies(gs);
            simCheckCollision(gs);
            if (!gs.alive || gs.levelWon) return gs.alive;
            // Stop after Coily lands and has started its next jump
            if (anyCoilyJumping) {
                var nowJumping = false;
                for (var ei2 = 0; ei2 < gs.enemies.length; ei2++) {
                    if (gs.enemies[ei2].type === 'coily') {
                        if (!gs.enemies[ei2].jumping) coilyLanded = true;
                        if (gs.enemies[ei2].jumping && coilyLanded) { nowJumping = true; break; }
                    }
                }
                if (nowJumping) break; // Coily landed then started new jump — good stopping point
            }
        }
        return true;
    }

    // Check collision before starting the move (enemy may already be on player's tile)
    simCheckCollision(gs);
    if (!gs.alive) return false;

    // Try to move
    if (!simTryMove(gs, dir)) return gs.alive;
    // If disc was used (instant teleport), simulate idle frames for enemies
    // Enough frames for Coily to chase the lure to the edge (~7 hops × 4 frames)
    if (!gs.player.jumping) {
        var hopFrames = 30;
        for (var f = 0; f < hopFrames; f++) {
            simUpdateEnemies(gs);
            // Player is off-grid on disc, no collision check needed
            if (!gs.alive || gs.levelWon) return gs.alive;
        }
        // Player lands at apex
        gs.player.row = 0;
        gs.player.col = 0;
        simStompCube(gs, 0, 0);
        // survivalOnly: cubes don't change, so simAllColored is stale — skip
        if (!gs.survivalOnly && simAllColored(gs)) {
            gs.score += roundCompletionBonus(gs.round);
            gs.score += unusedDiscBonus(gs.discs);
            gs.levelWon = true;
            return true;
        }
        // Check collision at apex after landing
        simCheckCollision(gs);
        return gs.alive;
    }

    // Run frame loop until player lands
    while (gs.player.jumping && gs.alive) {
        var result = simUpdatePlayer(gs);
        simUpdateEnemies(gs);
        simCheckCollision(gs);
        if (result === 'landed') {
            simStompCube(gs, gs.player.row, gs.player.col);
            // survivalOnly: cubes don't change, so simAllColored is stale — skip
            if (!gs.survivalOnly && simAllColored(gs)) {
                gs.score += roundCompletionBonus(gs.round);
                gs.score += unusedDiscBonus(gs.discs);
                gs.levelWon = true;
                return true;
            }
        }
        if (gs.levelWon) return true;
    }
    // Simulate 1 idle frame after landing — catch enemies about to land
    // on the player's tile in the brief window before the next jump starts.
    // The player stands idle for 1 frame while the AI decides the next move.
    if (gs.alive && !gs.player.jumping) {
        simUpdateEnemies(gs);
        simCheckCollision(gs);
    }
    return gs.alive;
}

// Forced hop-decision queue: when non-null, binary enemy hop decisions
// (DL/DR, up/stay) consume from this array instead of using simRng().
// Spawn-time decisions (column, dirBits) still use simRng() normally.
var simHopDecisionQ = null;
var simHopDecisionIdx = 0;

// Get a binary hop decision: 0 or 1 (maps to DL/DR or up/stay).
// Uses forced queue if available, otherwise simRng().
function simHopDecision() {
    if (simHopDecisionQ && simHopDecisionIdx < simHopDecisionQ.length) {
        return simHopDecisionQ[simHopDecisionIdx++] ? 0.75 : 0.25;
    }
    return simRng();
}

// simStep with forced enemy hop decisions. Used by expectimax to enumerate
// all enemy decision combinations without RNG dependency.
// Uses simStepSurvival when in survivalOnly mode for speed.
function simStepForced(gs, dir, choices) {
    simHopDecisionQ = choices;
    simHopDecisionIdx = 0;
    var result = gs.survivalOnly ? simStepSurvival(gs, dir) : simStep(gs, dir);
    simHopDecisionQ = null;
    return result;
}

// Count enemies that will make a random decision during one player hop.
// These are the ones that contribute 2^N branching in expectimax.
function countRandomDeciders(gs) {
    var pJumpFrames = Math.ceil(1 / (PLAYER_JUMP_DUR * gs.sm)) + 1;
    var count = 0;
    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type === 'spawn-timer') continue;
        if (e.type === 'coily') continue; // deterministic chase
        if ((e.type === 'redball' || e.type === 'greenball' || e.type === 'slick') && e.dirBits != null) continue; // deterministic path
        var framesUntilDecision;
        if (e.spawnAnimTimer > 0) {
            framesUntilDecision = e.spawnAnimTimer + (e.moveInterval || 12);
        } else if (e.jumping) {
            var framesToLand = Math.ceil((1.0 - (e.jumpT || 0)) / (e.jumpDur || ENEMY_JUMP_DUR * gs.sm));
            framesUntilDecision = framesToLand + (e.moveInterval || 12);
        } else {
            framesUntilDecision = (e.moveInterval || 12) - (e.moveTimer || 0);
        }
        if (framesUntilDecision <= pJumpFrames + 2) count++;
    }
    return count;
}

// Create a simulation state from current game globals
// (for AI to snapshot and search from)
function simCloneGameState() {
    var sm = speedMultiplier();
    var tgt = targetState();
    var lv = arcadeLevel();

    var cubes = new Array(cubeStates.length);
    for (var i = 0; i < cubeStates.length; i++)
        cubes[i] = { row: cubeStates[i].row, col: cubeStates[i].col, state: cubeStates[i].state };

    var ens = [];
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer') {
            ens.push({ type: 'spawn-timer', timer: e.timer, forcedType: e.forcedType || null });
            continue;
        }
        var en = { type: e.type, row: e.row, col: e.col,
                   jumping: !!e.jumping, jumpT: e.jumpT != null ? e.jumpT : 0,
                   jumpDur: e.jumpDur != null ? e.jumpDur : ENEMY_JUMP_DUR * sm,
                   destRow: e.destRow != null ? e.destRow : null,
                   destCol: e.destCol != null ? e.destCol : null,
                   jumpSrcRow: e.jumpSrcRow, jumpSrcCol: e.jumpSrcCol,
                   moveTimer: e.moveTimer != null ? e.moveTimer : 0,
                   moveInterval: e.moveInterval != null ? e.moveInterval : enemyMoveInterval(e.type, sm),
                   falling: !!e.falling, willHatch: !!e.willHatch,
                   hops: e.hops || 0,
                   spawnAnimTimer: e.spawnAnimTimer || 0 };
        if (e.dirBits != null) en.dirBits = e.dirBits;
        if (e.lureRow != null) { en.lureRow = e.lureRow; en.lureCol = e.lureCol; }
        ens.push(en);
    }

    var ds = [];
    for (var i = 0; i < discs.length; i++)
        ds[i] = { side: discs[i].side, row: discs[i].row, active: !!discs[i].active };

    var colored = 0;
    for (var i = 0; i < cubes.length; i++) colored += Math.min(cubes[i].state, tgt);

    var ft = (typeof freezeTimer !== 'undefined') ? freezeTimer : 0;

    return {
        player: { row: player.row, col: player.col,
                  prevRow: player.prevRow, prevCol: player.prevCol,
                  dead: !!player.dead, deathTimer: player.deathTimer || 0,
                  jumping: !!player.jumping, jumpT: player.jumpT != null ? player.jumpT : 0,
                  jumpDur: player.jumpDur != null ? player.jumpDur : PLAYER_JUMP_DUR * sm,
                  jumpSrcRow: player.jumpSrcRow, jumpSrcCol: player.jumpSrcCol,
                  destRow: player.destRow != null ? player.destRow : null,
                  destCol: player.destCol != null ? player.destCol : null },
        enemies: ens,
        cubes: cubes,
        discs: ds,
        sm: sm, tgt: tgt, lv: lv,
        cubesColored: colored,
        score: 0,
        alive: true,
        freezeTimer: ft,
        round: round,
        levelWon: false,
        oddRowFalls: (typeof gs !== 'undefined' ? gs.oddRowFalls : 0) || 0
    };
}
