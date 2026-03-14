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

// ─── Constants ───────────────────────────────────────────────────────────────
var ROWS = 7;
var DIRS = { UL: {dr:-1, dc:-1}, UR: {dr:-1, dc:0}, DL: {dr:1, dc:0}, DR: {dr:1, dc:1}, STAY: {dr:0, dc:0} };
var DIR_KEYS = ['UL', 'UR', 'DL', 'DR'];
var DIR_KEYS_WITH_STAY = ['UL', 'UR', 'DL', 'DR', 'STAY'];

// Frame timing (per-frame jumpT increments)
var PLAYER_JUMP_DUR = 0.028;
var ENEMY_JUMP_DUR  = 0.030;
var BASE_ENEMY_INTERVALS = {
    egg: 4, coily: 4, redball: 4, greenball: 12, slick: 20, ugg: 4, wrongway: 4
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
    var gs = (typeof gameSpeed !== 'undefined') ? gameSpeed : 1.0;
    return levelSpeed(rnd) * gs;
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
    if (lv === 2) return [3, 3, 3, 2][r];
    if (lv === 3) return [4, 4, 3, 3][r];
    if (lv === 4) return [6, 6, 5, 4][r];
    return [7, 6, 6, 5][r];
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

function discConfig(rnd) {
    var r = (rnd !== undefined) ? rnd : round;
    var count = discCount(r);
    var ri = ((r - 1) % 4);
    var result = [];
    result.push({side: 0, row: [2,3,2,3][ri]});
    result.push({side: 1, row: [3,2,3,2][ri]});
    if (count >= 3) result.push({side: [0,1,0,1][ri], row: [4,4,5,4][ri]});
    if (count >= 4) result.push({side: [1,0,1,0][ri], row: [5,5,4,5][ri]});
    if (count >= 5) result.push({side: 0, row: [5,4,3,5][ri]});
    if (count >= 6) result.push({side: 1, row: [4,5,5,3][ri]});
    if (count >= 7) result.push({side: [0,1,0,1][ri], row: [3,3,4,4][ri]});
    return result;
}

function roundCompletionBonus(rnd) {
    var r = (rnd !== undefined) ? rnd : round;
    return Math.min(5000, 750 + 250 * r);
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
    if (hasRedBall(rnd))     simScheduleSpawn(gs, 240, 'redball');
    if (hasSlick(rnd))       simScheduleSpawn(gs, 720, 'slick');
    if (hasGreenBall(rnd))   simScheduleSpawn(gs, 480, 'greenball');
    if (hasUggWrongway(rnd)) simScheduleSpawn(gs, 540, 'ugg');
    if (hasUggWrongway(rnd)) simScheduleSpawn(gs, 660, 'wrongway');
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
    var spawnCol = Math.floor(Math.random() * 2);
    var interval = enemyMoveInterval(type, gs.sm);
    if (type === 'ugg') {
        gs.enemies.push({ type: 'ugg', row: ROWS-1, col: ROWS-1,
            jumping: false, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * gs.sm,
            moveTimer: 0, moveInterval: interval, destRow: null, destCol: null });
    } else if (type === 'wrongway') {
        gs.enemies.push({ type: 'wrongway', row: ROWS-1, col: 0,
            jumping: false, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * gs.sm,
            moveTimer: 0, moveInterval: interval, destRow: null, destCol: null });
    } else {
        gs.enemies.push({ type: type, row: 1, col: spawnCol, hops: 0,
            jumping: false, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * gs.sm,
            moveTimer: 0, moveInterval: interval, destRow: null, destCol: null });
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

        // Jump animation
        if (e.jumping) {
            e.jumpT += e.jumpDur;
            if (e.jumpT >= 1) {
                e.jumpT = 1; e.jumping = false;
                e.row = e.destRow; e.col = e.destCol;
                e.destRow = null; e.destCol = null;
                // Fell off
                if (e.falling) {
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
            var dir = Math.random() < 0.5 ? 'DL' : 'DR';
            var delta = DIRS[dir];
            var nr = e.row + delta.dr, nc = e.col + delta.dc;
            e.hops = (e.hops || 0) + 1;
            simEnemyJumpTo(e, nr, nc, gs.sm);
            if (!isValidPos(nr, nc)) e.falling = true;
            else if (e.hops >= 6 || nr >= ROWS - 1) e.willHatch = true;
        } else if (e.type === 'coily') {
            var bestDir = null, bestDist = Infinity;
            // Coily chases player (or lure target if set)
            var targetR = (e.lureRow != null) ? e.lureRow : gs.player.row;
            var targetC = (e.lureCol != null) ? e.lureCol : gs.player.col;
            for (var k = 0; k < 4; k++) {
                var dk = DIRS[DIR_KEYS[k]];
                var enr = e.row + dk.dr, enc = e.col + dk.dc;
                if (!isValidPos(enr, enc)) continue;
                var dist = Math.abs(targetR - enr) + Math.abs(targetC - enc);
                if (dist < bestDist) { bestDist = dist; bestDir = { nr: enr, nc: enc }; }
            }
            if (bestDir) {
                simEnemyJumpTo(e, bestDir.nr, bestDir.nc, gs.sm);
            } else {
                simEnemyJumpTo(e, e.row, e.col, gs.sm);
                e.falling = true;
            }
        } else if (e.type === 'redball' || e.type === 'greenball' || e.type === 'slick') {
            var dir = Math.random() < 0.5 ? 'DL' : 'DR';
            var delta = DIRS[dir];
            var nr = e.row + delta.dr, nc = e.col + delta.dc;
            simEnemyJumpTo(e, nr, nc, gs.sm);
            if (!isValidPos(nr, nc)) e.falling = true;
        } else if (e.type === 'ugg') {
            var udir = Math.random() < 0.5;
            var unr = udir ? e.row - 1 : e.row;
            var unc = e.col - 1;
            simEnemyJumpTo(e, unr, unc, gs.sm);
            if (!isValidPos(unr, unc)) e.falling = true;
        } else if (e.type === 'wrongway') {
            var wdir = Math.random() < 0.5;
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
function simCheckCollision(gs) {
    if (gs.player.dead) return;
    var pt = collisionTile(gs.player);
    if (!pt) return; // player at apex, immune
    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type === 'spawn-timer') continue;
        var et = collisionTile(e);
        if (!et) continue; // enemy at apex, immune
        if (et.row === pt.row && et.col === pt.col) {
            if (e.type === 'slick') {
                gs.score += 300;
                gs.enemies.splice(i, 1); i--;
            } else if (e.type === 'greenball') {
                gs.score += 100;
                gs.freezeTimer = 300;
                gs.enemies.splice(i, 1); i--;
            } else {
                gs.alive = false;
                gs.player.dead = true;
                gs.deathEnemy = e.type;
                return;
            }
        }
    }
}

// Use a disc (player escapes to top, potentially kills Coily)
function simUseDisc(gs, idx) {
    var disc = gs.discs[idx];
    disc.active = false;
    var coilyDied = false;
    var kept = [];
    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type === 'coily') {
            // Simulate Coily chasing toward the disc exit over multiple hops
            var lureRow = disc.row;
            var lureCol = disc.side === 0 ? -1 : disc.row + 1;
            var cr = e.row, cc = e.col;
            var fellOff = false;
            for (var hop = 0; hop < 20; hop++) {
                var bestDir = null, bestDist = Infinity;
                for (var k = 0; k < DIR_KEYS.length; k++) {
                    var dk = DIRS[DIR_KEYS[k]];
                    var nr = cr + dk.dr, nc = cc + dk.dc;
                    var dist = Math.abs(lureRow - nr) + Math.abs(lureCol - nc);
                    if (dist < bestDist) { bestDist = dist; bestDir = { nr: nr, nc: nc }; }
                }
                if (!bestDir) break;
                if (!isValidPos(bestDir.nr, bestDir.nc)) { fellOff = true; break; }
                cr = bestDir.nr; cc = bestDir.nc;
            }
            if (fellOff) {
                gs.score += 500;
                coilyDied = true;
            } else {
                kept.push(e);
            }
        } else if (e.type === 'spawn-timer') {
            kept.push(e);
        } else {
            kept.push(e);
        }
    }
    if (coilyDied) {
        // When Coily dies, all non-spawn-timer enemies are cleared
        var spawnTimers = [];
        for (var i = 0; i < kept.length; i++)
            if (kept[i].type === 'spawn-timer') spawnTimers.push(kept[i]);
        gs.enemies = spawnTimers;
        // Schedule Coily respawn (new egg after delay)
        simScheduleSpawn(gs, 180);
    } else {
        gs.enemies = kept;
    }
    gs.player.row = 0;
    gs.player.col = 0;
    gs.player.jumping = false;
    simStompCube(gs, 0, 0);
}

// Try to move the player in a direction. Returns true if move started.
// Returns 'disc' if a disc was used.
function simTryMove(gs, dirKey) {
    if (gs.player.dead || gs.player.jumping) return false;
    var d = DIRS[dirKey]; if (!d) return false;
    var nr = gs.player.row + d.dr, nc = gs.player.col + d.dc;

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
                       moveTimer: e.moveTimer, moveInterval: e.moveInterval,
                       falling: e.falling || false, willHatch: e.willHatch || false,
                       hops: e.hops || 0 };
            if (e.lureRow != null) { ens[i].lureRow = e.lureRow; ens[i].lureCol = e.lureCol; }
        }
    }

    var ds = new Array(gs.discs.length);
    for (var i = 0; i < gs.discs.length; i++)
        ds[i] = { side: gs.discs[i].side, row: gs.discs[i].row, active: gs.discs[i].active };

    return {
        player: { row: gs.player.row, col: gs.player.col,
                  dead: gs.player.dead, deathTimer: gs.player.deathTimer || 0,
                  jumping: gs.player.jumping, jumpT: gs.player.jumpT,
                  jumpDur: gs.player.jumpDur,
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

// Simulate one complete player hop (start jump → frames until landing).
// Returns true if player survived, false if died.
function simStep(gs, dir) {
    if (dir === 'STAY') {
        // Stand still for one hop's worth of frames
        var hopFrames = Math.ceil(1.0 / gs.player.jumpDur);
        for (var f = 0; f < hopFrames; f++) {
            simUpdateEnemies(gs);
            simCheckCollision(gs);
            if (!gs.alive || gs.levelWon) return gs.alive;
        }
        return true;
    }

    // Try to move
    if (!simTryMove(gs, dir)) return gs.alive;
    // If disc was used (instant teleport), simulate idle frames for enemies
    if (!gs.player.jumping) {
        var hopFrames = Math.ceil(1.0 / (PLAYER_JUMP_DUR * gs.sm));
        for (var f = 0; f < hopFrames; f++) {
            simUpdateEnemies(gs);
            simCheckCollision(gs);
            if (!gs.alive || gs.levelWon) return gs.alive;
        }
        return gs.alive;
    }

    // Run frame loop until player lands
    while (gs.player.jumping && gs.alive) {
        var result = simUpdatePlayer(gs);
        simUpdateEnemies(gs);
        simCheckCollision(gs);
        if (result === 'landed') {
            simStompCube(gs, gs.player.row, gs.player.col);
            if (simAllColored(gs)) {
                gs.score += roundCompletionBonus(gs.round);
                gs.score += unusedDiscBonus(gs.discs);
                gs.levelWon = true;
                return true;
            }
        }
        if (gs.levelWon) return true;
    }
    return gs.alive;
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
                   moveTimer: e.moveTimer != null ? e.moveTimer : 0,
                   moveInterval: e.moveInterval != null ? e.moveInterval : enemyMoveInterval(e.type, sm),
                   falling: !!e.falling, willHatch: !!e.willHatch,
                   hops: e.hops || 0 };
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
                  dead: !!player.dead, deathTimer: player.deathTimer || 0,
                  jumping: !!player.jumping, jumpT: player.jumpT != null ? player.jumpT : 0,
                  jumpDur: player.jumpDur != null ? player.jumpDur : PLAYER_JUMP_DUR * sm,
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
        levelWon: false
    };
}
