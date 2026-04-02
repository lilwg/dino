// qbert-ai.js — Q*bert AI logic (strategy-based heuristic)
var AI_VERSION = 'v8.0-heuristic';
// Requires: qbert.js loaded first (provides constants, board, simulation)
//
// Provides: aiPickBestDir() — main entry point for AI move selection
//
// Human-style strategy AI:
//   1. Complete bottom corners first (fewer escape routes = do them early)
//   2. Lure Coily onto discs for safe working windows
//   3. Sweep remaining cubes bottom-up (never backtrack through completed cubes)
//   4. Thin safety layer: 1-hop danger check + Coily chase prediction

// ─── Safety: immediate danger check ─────────────────────────────────────────

// Is a tile dangerous? Checks current enemy positions AND where they'll
// be after one hop (enemies move during the player's ~35-frame flight).
function isTileDangerous(row, col, gs) {
    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type === 'spawn-timer' || e.type === 'slick' || e.type === 'greenball') continue;
        if (e.type === 'coily') continue; // handled separately by coilyThreatens
        if (e.spawnAnimTimer > 0) continue;

        // Effective position (where enemy is or will land)
        var er = e.row, ec = e.col;
        if (e.jumping && e.destRow != null) {
            // Enemy mid-jump: dangerous at both source (early) and dest (late)
            if (e.row === row && e.col === col) return true;
            if (e.destRow === row && e.destCol === col) return true;
            er = e.destRow; ec = e.destCol; // use landing pos for next-hop check
        } else {
            // Enemy idle: dangerous at current position
            if (er === row && ec === col) return true;
        }

        // Enemy's possible NEXT hop destinations (always check — the enemy will
        // move during our ~35-frame flight regardless of its current timer)
        if (e.type === 'egg' || e.type === 'redball') {
            if (er + 1 === row && (ec === col || ec + 1 === col)) return true;
        } else if (e.type === 'ugg') {
            if ((er - 1 === row && ec - 1 === col) || (er === row && ec - 1 === col)) return true;
        } else if (e.type === 'wrongway') {
            if ((er - 1 === row && ec === col) || (er === row && ec + 1 === col)) return true;
        }
    }

    // Spawn timers about to fire
    var sm = gs.sm || 1;
    var framesPerHop = Math.ceil(1 / (PLAYER_JUMP_DUR * sm));
    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type !== 'spawn-timer') continue;
        if (e.timer <= framesPerHop * 2) {
            var ft = e.forcedType;
            if (!ft) {
                var hasCoilyOrEgg = false;
                for (var j = 0; j < gs.enemies.length; j++)
                    if (gs.enemies[j].type === 'coily' || gs.enemies[j].type === 'egg') { hasCoilyOrEgg = true; break; }
                ft = hasCoilyOrEgg ? 'redball' : 'egg';
            }
            if (ft === 'ugg' && row === ROWS - 1 && col === ROWS - 1) return true;
            if (ft === 'wrongway' && row === ROWS - 1 && col === 0) return true;
            if ((ft === 'redball' || ft === 'egg') && row === 1 && (col === 0 || col === 1)) return true;
        }
    }
    return false;
}

// Predict Coily's next position using ROM chase algorithm
function coilyChaseStep(cr, cc, targetR, targetC) {
    var c_gw1 = cr - cc + 1;
    var t_gw1 = targetR - targetC + 1;
    var nr, nc;
    if (targetR > cr) {
        if (t_gw1 > c_gw1) { nr = cr + 1; nc = cc; }
        else                { nr = cr + 1; nc = cc + 1; }
    } else {
        if (t_gw1 < c_gw1) { nr = cr - 1; nc = cc; }
        else                { nr = cr - 1; nc = cc - 1; }
    }
    return isValidPos(nr, nc) ? { row: nr, col: nc } : null;
}

// Will Coily collide with us at destination? Check current pos + 2 chase steps.
function coilyThreatens(coily, destR, destC, playerR, playerC) {
    if (!coily) return false;
    var cr = coily.row, cc = coily.col;

    // Coily mid-jump: check both source and landing
    if (coily.jumping) {
        if (coily.row === destR && coily.col === destC) return true;
        if (coily.destRow === destR && coily.destCol === destC) return true;
        // After landing, where does Coily chase next?
        if (coily.destRow != null) {
            var afterLand = coilyChaseStep(coily.destRow, coily.destCol, destR, destC);
            if (afterLand && afterLand.row === destR && afterLand.col === destC) return true;
        }
        return false;
    }

    // Coily idle: check current + next 2 chase steps
    if (cr === destR && cc === destC) return true;

    // Chase toward player's current position (ROM behavior: chase prevPos)
    var next = coilyChaseStep(cr, cc, playerR, playerC);
    if (next && next.row === destR && next.col === destC) return true;

    // Chase toward our destination (in case Coily targets destR,destC)
    var next2 = coilyChaseStep(cr, cc, destR, destC);
    if (next2 && next2.row === destR && next2.col === destC) return true;

    // 2nd step: where does Coily go after its first step?
    if (next) {
        var step2 = coilyChaseStep(next.row, next.col, destR, destC);
        if (step2 && step2.row === destR && step2.col === destC) return true;
    }

    return false;
}

// Check if a direction is safe using frame-accurate simulation.
// Clones the game state, simulates the hop, checks if player survives.
// Also runs a few follow-up seeds to catch probabilistic deaths.
function isDirectionSafe(gs, dir, coily) {
    if (dir === 'STAY') {
        // STAY: check heuristically (no simStep for idle)
        if (isTileDangerous(gs.player.row, gs.player.col, gs)) return false;
        if (coilyThreatens(coily, gs.player.row, gs.player.col, gs.player.row, gs.player.col)) return false;
        return true;
    }
    var d = DIRS[dir];
    var nr = gs.player.row + d.dr, nc = gs.player.col + d.dc;
    if (!isValidPos(nr, nc)) return true; // disc move — escape is always safe

    // Quick heuristic pre-filter
    if (coilyThreatens(coily, nr, nc, gs.player.row, gs.player.col)) return false;

    // Frame-accurate: simulate the actual hop with multiple RNG seeds
    var savedRng = simRng;
    var baseSeed = (gs.player.row * 7 + gs.player.col) * 10000 + (typeof frameCount !== 'undefined' ? frameCount : 0);
    var deathCount = 0;
    var NUM_SEEDS = 5;
    for (var s = 0; s < NUM_SEEDS; s++) {
        simRng = createSeededRng(baseSeed + s * 9973);
        var clone = simDeepClone(gs);
        var alive = simStep(clone, dir);
        if (!alive) deathCount++;
    }
    simRng = savedRng;

    // Die in majority of seeds = unsafe
    return deathCount < NUM_SEEDS / 2;
}

// Count valid exits from a position (mobility)
function countExits(row, col) {
    var exits = 0;
    for (var k = 0; k < DIR_KEYS.length; k++) {
        var d = DIRS[DIR_KEYS[k]];
        if (isValidPos(row + d.dr, col + d.dc)) exits++;
    }
    return exits;
}

// ─── Disc luring ─────────────────────────────────────────────────────────────

// Find the best disc to lure Coily onto.
// Returns {disc, adjRow, adjCol, adjDist, discDir} or null.
function findBestDisc(gs, coily) {
    if (!coily) return null;
    var best = null, bestDist = 999;
    for (var i = 0; i < gs.discs.length; i++) {
        var disc = gs.discs[i];
        if (!disc.active) continue;
        var adjR = disc.row;
        var adjC = disc.side === 0 ? 0 : disc.row;
        var discDir = disc.side === 0 ? 'UL' : 'UR';
        var d = exBfsDist(gs.player.row, gs.player.col, adjR, adjC);
        if (d < bestDist) {
            bestDist = d;
            best = { disc: disc, adjRow: adjR, adjCol: adjC, adjDist: d, discDir: discDir };
        }
    }
    return best;
}

// Would Coily fall off if we jumped on this disc?
function wouldCoilyBeLured(coily, disc) {
    // Simulate Coily chasing the disc-adjacent position for a few steps
    var adjR = disc.row;
    var adjC = disc.side === 0 ? 0 : disc.row;
    var cr = coily.row, cc = coily.col;
    for (var s = 0; s < 6; s++) {
        var next = coilyChaseStep(cr, cc, adjR, adjC);
        if (!next) return true; // Coily would step off the board
        cr = next.row; cc = next.col;
        if (cr === adjR && cc === adjC) {
            // Coily reaches the disc position — one more step chasing off-board
            var step = disc.side === 0
                ? coilyChaseStep(cr, cc, adjR - 1, -1)
                : coilyChaseStep(cr, cc, adjR - 1, adjR + 1);
            return !step; // falls off
        }
    }
    return false;
}

// ─── Target selection ────────────────────────────────────────────────────────

// Define corner regions (bottom-left and bottom-right of the pyramid)
// Left corner: row 4-6, leftmost cols. Right corner: row 4-6, rightmost cols.
function isLeftCorner(row, col) { return row >= 4 && col <= 1; }
function isRightCorner(row, col) { return row >= 4 && col >= row - 1; }

// Find the best target cube to aim for.
// Strategy: corners first (they have fewest exits), then bottom-up sweep.
function findTarget(gs) {
    var pR = gs.player.row, pC = gs.player.col;
    var tgt = gs.tgt;

    // Collect unfinished cubes
    var unfinished = [];
    var leftCornerLeft = 0, rightCornerLeft = 0;
    for (var i = 0; i < gs.cubes.length; i++) {
        var c = gs.cubes[i];
        if (stompsNeeded(c.state, gs.lv) > 0) {
            unfinished.push(c);
            if (isLeftCorner(c.row, c.col)) leftCornerLeft++;
            if (isRightCorner(c.row, c.col)) rightCornerLeft++;
        }
    }
    if (unfinished.length === 0) return null;

    // Priority 1: Finish whichever corner has more work (do hard areas first)
    // Priority 2: Bottom-up sweep (highest row first)
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < unfinished.length; i++) {
        var c = unfinished[i];
        var dist = exBfsDist(pR, pC, c.row, c.col);
        var score = 0;

        // Strong preference for bottom rows (bottom-up sweep)
        score += c.row * 10;

        // Corner bonus: finish corners first when they have work
        if (isLeftCorner(c.row, c.col) && leftCornerLeft > 0) score += 30;
        if (isRightCorner(c.row, c.col) && rightCornerLeft > 0) score += 30;

        // Prefer closer cubes among equal-priority targets
        score -= dist * 3;

        // On toggle levels, avoid cubes we'd need to cross completed cubes to reach
        if (gs.lv >= 3) {
            // Penalty for cubes far from current position on the same row level
            // (reaching them likely means crossing completed cubes)
            if (dist > 4) score -= (dist - 4) * 5;
        }

        if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
}

// How many stomps does a cube need to reach target state?
function stompsNeeded(cubeState, lv) {
    var tgt = (lv === 1 || lv === 3) ? 1 : 2;
    if (cubeState >= tgt) return 0;
    if (lv <= 2) return tgt - cubeState;
    if (lv === 3) return cubeState === 0 ? 1 : 0;
    if (lv === 4) return cubeState === 0 ? 2 : (cubeState === 1 ? 1 : 0);
    return cubeState === 0 ? 2 : (cubeState === 1 ? 1 : 0);
}

// ─── Direction scoring ───────────────────────────────────────────────────────

function scoreDirection(gs, dir, target, coily, discInfo) {
    var pR = gs.player.row, pC = gs.player.col;

    if (dir === 'STAY') {
        var score = 0;
        // STAY is rarely good — small penalty
        score -= 5;
        // But useful when waiting for Coily to approach for a lure
        if (discInfo && coily) {
            var atDisc = (pR === discInfo.adjRow && pC === discInfo.adjCol);
            if (atDisc) {
                var coilyDist = exBfsDist(coily.row, coily.col, pR, pC);
                if (coilyDist <= 3) score += 50; // wait for Coily to get close
            }
        }
        return score;
    }

    var d = DIRS[dir];
    var nr = pR + d.dr, nc = pC + d.dc;

    // Disc move: check if it's a lure opportunity
    if (!isValidPos(nr, nc)) {
        // This is a disc move — only take it if Coily is close enough to lure
        if (!coily) return -100; // no Coily, don't waste disc
        var coilyDist = exBfsDist(coily.row, coily.col, pR, pC);
        if (coilyDist <= 3) return 200; // great lure opportunity
        if (coilyDist <= 5) return 50;  // decent
        return -50; // Coily too far, disc would be wasted
    }

    var score = 0;

    // Progress: does this land on an unfinished cube?
    for (var i = 0; i < gs.cubes.length; i++) {
        var c = gs.cubes[i];
        if (c.row === nr && c.col === nc) {
            if (stompsNeeded(c.state, gs.lv) > 0) {
                score += 25; // making progress!
            } else if (gs.lv >= 3) {
                score -= 15; // toggle level: stepping on completed cube reverts it
            }
            break;
        }
    }

    // Move toward target
    if (target) {
        var distBefore = exBfsDist(pR, pC, target.row, target.col);
        var distAfter = exBfsDist(nr, nc, target.row, target.col);
        score += (distBefore - distAfter) * 8;
    }

    // Move toward disc when luring
    if (discInfo && coily) {
        var discDistBefore = exBfsDist(pR, pC, discInfo.adjRow, discInfo.adjCol);
        var discDistAfter = exBfsDist(nr, nc, discInfo.adjRow, discInfo.adjCol);
        var coilyDist = exBfsDist(coily.row, coily.col, pR, pC);
        // Only add disc bonus if Coily is reasonably close
        if (coilyDist <= 6) {
            score += (discDistBefore - discDistAfter) * 12;
        }
    }

    // Coily avoidance: prefer distance from Coily
    if (coily) {
        var coilyDistAfter = exBfsDist(nr, nc, coily.row, coily.col);
        score += coilyDistAfter * 2;
    }

    // Mobility: prefer tiles with more escape routes
    var exits = countExits(nr, nc);
    score += exits * 3;

    // Strongly avoid low-exit tiles when Coily is close
    if (coily && exits <= 2) {
        var coilyDist = exBfsDist(nr, nc, coily.row, coily.col);
        if (coilyDist <= 4) score -= (5 - coilyDist) * 15;
    }

    // Avoid bottom-row edges (easy to get cornered)
    if (nr >= ROWS - 2 && (nc === 0 || nc === nr)) score -= 10;

    return score;
}

// ─── Can-move check ──────────────────────────────────────────────────────────
function simCanMove(gs, dirKey) {
    if (dirKey === 'STAY') return true;
    var d = DIRS[dirKey];
    var nr = gs.player.row + d.dr, nc = gs.player.col + d.dc;
    if (isValidPos(nr, nc)) return true;
    for (var di = 0; di < gs.discs.length; di++) {
        var disc = gs.discs[di];
        if (!disc.active) continue;
        if (disc.side === 0 && dirKey === 'UL' && gs.player.col === 0 && gs.player.row === disc.row) return true;
        if (disc.side === 1 && dirKey === 'UR' && gs.player.col === gs.player.row && gs.player.row === disc.row) return true;
    }
    return false;
}

// ─── Main entry point ────────────────────────────────────────────────────────
var aiMoveScores = {};
var aiLastTourCosts = {};
var aiLastHop1Surv = {};
var aiMode = 0;
var aiStayCount = 0;
var aiLastPos = '';
var aiSamePosCount = 0;
var aiLastRemaining = 99;
var aiBestRemaining = 99;
var aiNoProgressCount = 0;
var aiPosHistory = [];
var AI_HISTORY_LEN = 12;

// For viz compatibility
var aiRevertCounts = new Int8Array(POS_COUNT);
var aiPrevCubeStates = null;
var aiTour = [], aiTourIdx = 0, aiBoardSig = '';
var aiDetailPath = [], aiTourDots = [];

function aiTourInit() {
    aiLastRemaining = 99; aiBestRemaining = 99; aiNoProgressCount = 0;
    aiStayCount = 0; aiSamePosCount = 0; aiPosHistory = [];
    aiRevertCounts = new Int8Array(POS_COUNT);
    aiPrevCubeStates = null;
}

function aiPickBestDir() {
    var gs = simCloneGameState();
    aiMoveScores = {};
    aiMode = 1;

    // Find Coily
    var coily = null;
    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type === 'coily') {
            coily = { row: e.row, col: e.col, jumping: e.jumping,
                      jumpT: e.jumpT, destRow: e.destRow, destCol: e.destCol,
                      moveTimer: e.moveTimer, moveInterval: e.moveInterval };
            // Use effective position if mid-jump past apex
            if (e.jumping && e.jumpT >= 0.5 && e.destRow != null) {
                coily.row = e.destRow; coily.col = e.destCol;
            }
            break;
        }
    }

    // Find best disc for luring
    var discInfo = coily ? findBestDisc(gs, coily) : null;

    // Should we be in lure mode?
    var lureMode = false;
    if (coily && discInfo && discInfo.adjDist <= 5) {
        var coilyDist = exBfsDist(coily.row, coily.col, gs.player.row, gs.player.col);
        if (coilyDist <= 7) lureMode = true;
    }

    // Find target cube
    var target = lureMode ? null : findTarget(gs);

    // Score each direction
    var bestDir = null, bestScore = -Infinity;
    var safeDirs = [], unsafeDirs = [];

    for (var k = 0; k < DIR_KEYS_WITH_STAY.length; k++) {
        var dir = DIR_KEYS_WITH_STAY[k];
        if (!simCanMove(gs, dir)) continue;

        // Don't waste discs when there's no Coily
        if (!coily && dir !== 'STAY') {
            var dd = DIRS[dir];
            var dnr = gs.player.row + dd.dr, dnc = gs.player.col + dd.dc;
            if (!isValidPos(dnr, dnc)) continue;
        }

        var safe = isDirectionSafe(gs, dir, coily);
        var score = scoreDirection(gs, dir, target, coily, lureMode ? discInfo : null);

        if (!safe) score -= 1000;

        aiMoveScores[dir] = score;

        if (safe) safeDirs.push({ dir: dir, score: score });
        else unsafeDirs.push({ dir: dir, score: score });

        if (score > bestScore) { bestScore = score; bestDir = dir; }
    }

    // Prefer safe directions — only pick unsafe if no safe option exists
    if (safeDirs.length > 0) {
        bestDir = null; bestScore = -Infinity;
        for (var i = 0; i < safeDirs.length; i++) {
            if (safeDirs[i].score > bestScore) {
                bestScore = safeDirs[i].score;
                bestDir = safeDirs[i].dir;
            }
        }
    }

    // Anti-oscillation: if we're looping, try a different safe direction
    var posKey = gs.player.row + ',' + gs.player.col;
    aiPosHistory.push(posKey);
    if (aiPosHistory.length > AI_HISTORY_LEN) aiPosHistory.shift();

    if (bestDir && bestDir !== 'STAY' && aiPosHistory.length >= 4) {
        var h = aiPosHistory;
        var len = h.length;
        // A-B-A pattern
        if (len >= 3 && h[len-1] === h[len-3] && h[len-1] !== h[len-2]) {
            var dd = DIRS[bestDir];
            var destKey = (gs.player.row + dd.dr) + ',' + (gs.player.col + dd.dc);
            if (len >= 2 && destKey === h[len-2]) {
                // We'd oscillate — pick a different safe direction
                for (var i = 0; i < safeDirs.length; i++) {
                    if (safeDirs[i].dir === bestDir || safeDirs[i].dir === 'STAY') continue;
                    var ad = DIRS[safeDirs[i].dir];
                    var aKey = (gs.player.row + ad.dr) + ',' + (gs.player.col + ad.dc);
                    if (aKey !== h[len-2] && aKey !== h[len-1]) {
                        bestDir = safeDirs[i].dir;
                        break;
                    }
                }
            }
        }
    }

    // Populate survival display for viz compatibility
    aiLastHop1Surv = {};
    aiLastTourCosts = {};
    for (var dir in aiMoveScores) {
        aiLastHop1Surv[dir] = aiMoveScores[dir] > -500 ? 1.0 : 0.0;
        aiLastTourCosts[dir] = -aiMoveScores[dir];
    }

    return bestDir || 'STAY';
}

// ─── Viz support ─────────────────────────────────────────────────────────────
// buildDangerSet is called from dino-qbert.html for rendering danger tiles
function predictCoilyPos(coily, targetRow, targetCol, steps) {
    var cr = coily.row, cc = coily.col;
    for (var s = 0; s < steps; s++) {
        var next = coilyChaseStep(cr, cc, targetRow, targetCol);
        if (!next) break;
        cr = next.row; cc = next.col;
    }
    return { row: cr, col: cc };
}

function buildDangerSet() {
    var danger = {};
    var sm = (typeof speedMultiplier === 'function') ? speedMultiplier() : 1;
    var framesPerHop = Math.ceil(1 / (PLAYER_JUMP_DUR * sm));
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'slick' || e.type === 'greenball') continue;
        if (e.type === 'coily') {
            var cpos = enemyEffectivePos(e);
            danger[cpos.row + ',' + cpos.col] = true;
            var pr = cpos.row, pc = cpos.col;
            for (var cs = 0; cs < 3; cs++) {
                var cp = predictCoilyPos({ row: pr, col: pc }, player.row, player.col, 1);
                if (!isValidPos(cp.row, cp.col)) break;
                danger[cp.row + ',' + cp.col] = true;
                pr = cp.row; pc = cp.col;
            }
            continue;
        }
        if (e.type === 'spawn-timer') {
            if (e.timer <= framesPerHop) {
                var ft = e.forcedType;
                if (ft === 'ugg') danger[(ROWS-1) + ',' + (ROWS-1)] = true;
                else if (ft === 'wrongway') danger[(ROWS-1) + ',0'] = true;
                else { danger['1,0'] = true; danger['1,1'] = true; }
            }
            continue;
        }
        var pos = enemyEffectivePos(e);
        var er = pos.row, ec = pos.col;
        danger[er + ',' + ec] = true;
        if (e.type === 'egg' || e.type === 'redball') {
            if (e.jumping && e.destRow != null) {
                danger[e.destRow + ',' + e.destCol] = true;
            } else {
                if (isValidPos(er + 1, ec)) danger[(er + 1) + ',' + ec] = true;
                if (isValidPos(er + 1, ec + 1)) danger[(er + 1) + ',' + (ec + 1)] = true;
            }
            if (e.type === 'egg' && ((e.hops || 0) >= 5 || e.willHatch)) {
                for (var ek = 0; ek < DIR_KEYS.length; ek++) {
                    var edk = DIRS[DIR_KEYS[ek]];
                    var enr = er + edk.dr, enc = ec + edk.dc;
                    if (isValidPos(enr, enc)) danger[enr + ',' + enc] = true;
                }
            }
        }
        if (e.type === 'ugg') {
            if (isValidPos(er - 1, ec - 1)) danger[(er-1) + ',' + (ec-1)] = true;
            if (isValidPos(er, ec - 1)) danger[er + ',' + (ec-1)] = true;
        }
        if (e.type === 'wrongway') {
            if (isValidPos(er - 1, ec)) danger[(er-1) + ',' + ec] = true;
            if (isValidPos(er, ec + 1)) danger[er + ',' + (ec+1)] = true;
        }
    }
    return danger;
}
