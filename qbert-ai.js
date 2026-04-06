// qbert-ai.js — Q*bert AI: hybrid strategy + survival tree
var AI_VERSION = 'v12.1-hybrid-expectimax';
// Requires: qbert.js loaded first (provides constants, board, simulation)
//
// Provides: aiPickBestDir() — main entry point for AI move selection
//
// Architecture: human-style strategy decides WHERE to go, survival tree
// validates IF it's safe. Best of both worlds.
//
// Strategy layer (greedyTourCost):
//   - Bottom-up sweep: complete lower rows first, never backtrack
//   - Corner priority: finish low-exit corner cubes early
//   - Cluster awareness: prefer cubes near other unfinished cubes
//   - Active disc luring: route toward discs when Coily is active
//   - Corner escape: avoid low-exit tiles when Coily is nearby
//
// Safety layer (survive/surviveOne):
//   - Factored survival tree: P(survive) = product of per-enemy trees
//   - Coily simulated deterministically (ROM chase algorithm)
//   - Frame-accurate collision detection during mid-hop flight
//   - 8-hop lookahead with memoized AND-OR tree

// ─── Tour planning ───────────────────────────────────────────────────────────

// How many stomps does a cube need to reach target state?
function stompsNeeded(cubeState, lv) {
    var tgt = (lv === 1 || lv === 3) ? 1 : 2;
    if (cubeState >= tgt) return 0;
    if (lv <= 2) return tgt - cubeState;
    if (lv === 3) return cubeState === 0 ? 1 : 0;
    if (lv === 4) return cubeState === 0 ? 2 : (cubeState === 1 ? 1 : 0);
    return cubeState === 0 ? 2 : (cubeState === 1 ? 1 : 0);
}


// Dijkstra from srcIdx with penalty for stepping on completed cubes.
// discSources: optional array of idx that have a 1-hop disc edge to apex (idx 0).
// Returns {dist, prev, usedDisc} — usedDisc[v] is the disc source idx if shortest
// path to v used a disc, else -1.
function dijkstraFrom(srcIdx, stomps, penalty, discSources) {
    var dist = new Float64Array(POS_COUNT);
    var prev = new Int8Array(POS_COUNT);
    var visited = new Uint8Array(POS_COUNT);
    var usedDisc = new Int8Array(POS_COUNT);
    for (var i = 0; i < POS_COUNT; i++) { dist[i] = 999; prev[i] = -1; usedDisc[i] = -1; }
    dist[srcIdx] = 0; prev[srcIdx] = srcIdx;
    for (var iter = 0; iter < POS_COUNT; iter++) {
        var u = -1, uDist = 999;
        for (var i = 0; i < POS_COUNT; i++) {
            if (!visited[i] && dist[i] < uDist) { uDist = dist[i]; u = i; }
        }
        if (u < 0) break;
        visited[u] = 1;
        var adj = posAdj[u];
        for (var a = 0; a < adj.length; a++) {
            var v = adj[a];
            if (visited[v]) continue;
            var cost = 1 + (stomps[v] === 0 ? penalty : 0);
            var nd = dist[u] + cost;
            if (nd < dist[v]) { dist[v] = nd; prev[v] = u; usedDisc[v] = usedDisc[u]; }
        }
        // Disc edge: from disc-adjacent cube to apex (idx 0) in 1 hop
        if (discSources) {
            for (var d = 0; d < discSources.length; d++) {
                if (discSources[d] >= 0 && u === discSources[d] && !visited[0]) {
                    var cost = 1 + (stomps[0] === 0 ? penalty : 0);
                    var nd = dist[u] + cost;
                    if (nd < dist[0]) {
                        dist[0] = nd; prev[0] = u;
                        usedDisc[0] = d; // track which disc index was used
                    }
                }
            }
        }
    }
    return {dist: dist, prev: prev, usedDisc: usedDisc};
}

// Greedy nearest-neighbor tour cost with deterministic tie-breaking.
// On toggle levels, uses Dijkstra to route around completed cubes.
// Ties broken by lowest position index for stability.
function greedyTourCost(startIdx, cubes, tgt, lv, discs, revertCounts) {
    var stomps = new Int8Array(POS_COUNT);
    for (var i = 0; i < cubes.length; i++) {
        var idx = posToIdx[cubes[i].row * ROWS + cubes[i].col];
        stomps[idx] = stompsNeeded(cubes[i].state, lv);
    }

    // Build disc source list: cube positions adjacent to active discs
    var discSources = [];
    if (discs) {
        for (var di = 0; di < discs.length; di++) {
            var disc = discs[di];
            if (!disc.active) continue;
            var dCol = disc.side === 0 ? 0 : disc.row;
            discSources.push(posToIdx[disc.row * ROWS + dCol]);
        }
    }

    var isToggle = lv >= 3;
    // L3-4 (toggle): penalty 1.5 (lower = allow more backtracking, detours cost more)
    // L5+ (cycle): penalty 2.5 (higher = reverts cost 3 stomps to fix)
    var REVERT_PENALTY = lv >= 5 ? 2.5 : (isToggle ? 1.5 : 0);
    var curIdx = startIdx;
    var totalHops = 0;

    for (var iter = 0; iter < 200; iter++) {
        if (isToggle) {
            var dijk = dijkstraFrom(curIdx, stomps, REVERT_PENALTY, discSources);

            var bestIdx = -1, bestDist = 999;
            for (var i = 0; i < POS_COUNT; i++) {
                if (stomps[i] > 0 && i !== curIdx) {
                    var d = dijk.dist[i];
                    // Deprioritize frequently-reverted cubes — go to fresh ones first
                    if (revertCounts && revertCounts[i] > 1) d += (revertCounts[i] - 1) * 3;
                    // Prefer cubes not visited recently — breaks oscillation loops
                    // by steering toward "forgotten" cubes instead of re-visiting familiar ones
                    var curHops = typeof hops !== 'undefined' ? hops : 0;
                    var hopsSinceVisit = curHops - (aiCubeLastVisit[i] || 0);
                    if (hopsSinceVisit < 20) d += (20 - hopsSinceVisit) * 0.5;
                    // Bottom-up sweep: prefer bottom-row cubes to avoid backtracking
                    // through completed upper cubes. Stronger on L3-4 where reverts hurt.
                    var row_i = idxToPos[i][0], col_i = idxToPos[i][1];
                    d -= row_i * (lv >= 5 ? 1.5 : 2);
                    // Corner priority: bottom corners (few exits) should be done first
                    if (row_i >= 4 && (col_i <= 1 || col_i >= row_i - 1)) d -= 2;
                    // Cluster bonus: prefer cubes with unfinished neighbors (sweep clusters together)
                    var adj = posAdj[i];
                    for (var ai = 0; ai < adj.length; ai++) {
                        if (stomps[adj[ai]] > 0) d -= 0.5;
                    }
                    if (d < bestDist || (d === bestDist && (bestIdx === -1 || i < bestIdx))) {
                        bestDist = d; bestIdx = i;
                    }
                }
            }
            if (bestIdx === -1) {
                if (stomps[curIdx] > 0) totalHops += stomps[curIdx] * 2;
                break;
            }

            // Consume the disc if the path to bestIdx used one
            var discIdx = dijk.usedDisc[bestIdx];
            if (discIdx >= 0 && discIdx < discSources.length) {
                discSources[discIdx] = -1; // mark consumed, don't splice (indices are stable)
            }

            // Walk the Dijkstra path, count real hops
            var path = [], pc = bestIdx;
            while (pc !== curIdx) { path.push(pc); pc = dijk.prev[pc]; }
            totalHops += path.length;

            // Apply stomps along path; fix reverts immediately (never leave debt)
            for (var p = path.length - 1; p >= 0; p--) {
                var pos = path[p];
                if (stomps[pos] > 0) {
                    stomps[pos]--;
                } else {
                    totalHops += 2;
                }
            }
            curIdx = bestIdx;
        } else {
            // Non-toggle: use precomputed BFS distances, consider disc shortcuts
            var bestIdx = -1, bestDist = 999;
            var APEX = 0;
            for (var i = 0; i < POS_COUNT; i++) {
                if (stomps[i] > 0 && i !== curIdx) {
                    var d = distMatrix[curIdx * POS_COUNT + i];
                    for (var ds = 0; ds < discSources.length; ds++) {
                        if (discSources[ds] < 0) continue; // consumed
                        var dd = distMatrix[curIdx * POS_COUNT + discSources[ds]] + 1
                               + distMatrix[APEX * POS_COUNT + i];
                        if (dd < d) d = dd;
                    }
                    if (d < bestDist || (d === bestDist && (bestIdx === -1 || i < bestIdx))) {
                        bestDist = d; bestIdx = i;
                    }
                }
            }
            if (bestIdx === -1) {
                if (stomps[curIdx] > 0) totalHops += stomps[curIdx] * 2;
                break;
            }
            // Check if a disc was used for this leg and consume it
            var directDist = distMatrix[curIdx * POS_COUNT + bestIdx];
            var usedDs = -1;
            for (var ds = 0; ds < discSources.length; ds++) {
                if (discSources[ds] < 0) continue; // consumed
                var dd = distMatrix[curIdx * POS_COUNT + discSources[ds]] + 1
                       + distMatrix[APEX * POS_COUNT + bestIdx];
                if (dd < directDist) { directDist = dd; usedDs = ds; }
            }
            if (usedDs >= 0) discSources[usedDs] = -1; // mark consumed
            totalHops += bestDist;
            stomps[bestIdx]--;
            curIdx = bestIdx;
        }
    }

    return totalHops;
}

// Tour cost from a simulation state
function simTourCost(gs) {
    return greedyTourCost(posToIdx[gs.player.row * ROWS + gs.player.col], gs.cubes, gs.tgt, gs.lv, gs.discs, aiRevertCounts);
}

// ─── Danger zone assessment ──────────────────────────────────────────────────

// Simulate Coily chase using actual ROM grid-word algorithm (deterministic)
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


function predictCoilyPos(coily, targetRow, targetCol, steps) {
    var cr = coily.row, cc = coily.col;
    for (var s = 0; s < steps; s++) {
        var next = coilyChaseStep(cr, cc, targetRow, targetCol);
        if (!next) break;
        cr = next.row; cc = next.col;
    }
    return { row: cr, col: cc };
}

// Build danger set — marks tiles where non-Coily enemies are or will move
function buildDangerSet() {
    var danger = {};
    var sm = (typeof speedMultiplier === 'function') ? speedMultiplier() : 1;
    var framesPerHop = Math.ceil(1 / (PLAYER_JUMP_DUR * sm));
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'slick' || e.type === 'greenball') continue;
        if (e.type === 'coily') {
            // Mark Coily's current position + predicted next 3 hops
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
                // Mid-jump: only the committed destination is dangerous
                danger[e.destRow + ',' + e.destCol] = true;
            } else {
                // Idle: both DL and DR are possible next hops
                if (isValidPos(er + 1, ec)) danger[(er + 1) + ',' + ec] = true;
                if (isValidPos(er + 1, ec + 1)) danger[(er + 1) + ',' + (ec + 1)] = true;
            }
            // Egg about to hatch into Coily — mark all adjacent tiles dangerous
            if (e.type === 'egg' && ((e.hops || 0) >= 5 || e.willHatch)) {
                // Egg about to hatch into Coily — mark all 4 adjacent tiles
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


// ─── Tour greedy planner ─────────────────────────────────────────────────────
var aiTour = [], aiTourIdx = 0, aiBoardSig = '';
var aiDetailPath = [], aiTourDots = [];

var aiRevertCounts = new Int8Array(POS_COUNT); // per-cube revert counter for toggle levels
var aiPrevCubeStates = null; // previous cube states to detect reverts
var aiCubeLastVisit = new Int32Array(POS_COUNT); // hop number when each cube was last stomped

function aiTourInit() {
    aiLastRemaining = 99; aiBestRemaining = 99; aiNoProgressCount = 0; aiStayCount = 0; aiSamePosCount = 0; aiPosHistory = [];
    aiRevertCounts = new Int8Array(POS_COUNT);
    aiPrevCubeStates = null;
    aiCubeLastVisit = new Int32Array(POS_COUNT);
}

// Dijkstra tour planner — nearest unfinished cube via weighted BFS
// On toggle levels (lv3+), uses cluster-based sweep planning:
// finds connected components of unfinished cubes and targets the nearest
// cluster's closest member, preferring paths that don't cross completed cubes.


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

// ─── Route-first AI: plan optimal path, validate safety via AND-OR tree ──────
// Philosophy: tour planner decides WHERE to go (optimal routing), AND-OR tree
// validates IF it's safe (can survive DEPTH hops against all enemy combos).

// Persistent memo: surviveOne and survive results are deterministic given state.
// Same (player, coily, enemy, depth) always gives same result. No need to clear
// between AI calls — entries from previous calls are still valid.
// Only clear when speed multiplier changes (timing parameters change).
var _persistMemo = new Map();
var _persistMemoSm = 0;
var _persistMemoCount = 0;

// ─── (Danger table code removed — survival now uses simStep directly) ────────

function unifiedPick(gs, coilyActive) {
    var _perfStart = typeof performance !== 'undefined' ? performance.now() : 0;
    var savedRng = simRng;
    var baseSeed = (gs.player.row * 7 + gs.player.col) * 10000 + (frameCount || 0);
    function simSeed(sampleIdx) { simRng = createSeededRng(baseSeed + sampleIdx * 9973); }
    function restoreRng() { simRng = savedRng; }

    // Reset prediction timeline for validation harness
    window.aiPredictedTimeline = null;

    var hasEnemies = gs.enemies.length > 0;
    var baseDepth = window.AI_DEPTH || 8;
    var DEPTH = hasEnemies ? baseDepth : 0;

    var pJumpDur = PLAYER_JUMP_DUR * gs.sm;
    var pJumpFrames = Math.ceil(1 / pJumpDur);
    var cJumpDur = ENEMY_JUMP_DUR * gs.sm;
    var cIdleFrames = enemyMoveInterval('coily', gs.sm);

    // Time budget: cap AI computation to avoid frame drops
    var _aiStartTime = typeof performance !== 'undefined' ? performance.now() : 0;
    var _aiDeadline = _aiStartTime + 80; // total budget
    var _dirDeadline = Infinity; // per-direction deadline, set in direction loop

    // Cross-timestep memo: persist across AI calls, clear on speed change or overflow
    if (gs.sm !== _persistMemoSm || _persistMemoCount > 50000) {
        _persistMemo = new Map(); _persistMemoSm = gs.sm; _persistMemoCount = 0;
    }
    var memo = _persistMemo;

    // ── Collect non-Coily enemy states ──
    var coilyInit = null;
    var enemyInits = [];
    for (var ei = 0; ei < gs.enemies.length; ei++) {
        var e = gs.enemies[ei];
        if (e.type === 'coily') {
            coilyInit = { row: e.row, col: e.col, jumping: !!e.jumping,
                jumpT: e.jumpT || 0, moveTimer: e.moveTimer || 0,
                destRow: e.destRow, destCol: e.destCol,
                lureRow: e.lureRow != null ? e.lureRow : null,
                lureCol: e.lureCol != null ? e.lureCol : null };
            continue;
        }
        if (e.type === 'slick' || e.type === 'greenball') continue;
        if (e.type === 'spawn-timer') {
            // Convert spawn-timer to the enemy it will produce
            if (e.timer > DEPTH * pJumpFrames + 50) continue; // too far in the future
            var ft = e.forcedType;
            if (!ft) {
                var hasCoilyOrEgg = false;
                for (var sti = 0; sti < gs.enemies.length; sti++)
                    if (gs.enemies[sti].type === 'coily' || gs.enemies[sti].type === 'egg') { hasCoilyOrEgg = true; break; }
                ft = hasCoilyOrEgg ? 'redball' : 'egg';
            }
            if (ft === 'ugg') {
                enemyInits.push({ type: 'ugg', row: ROWS-1, col: ROWS-1, jumping: false, jumpT: 0,
                    jumpDur: ENEMY_JUMP_DUR * gs.sm, moveTimer: 0,
                    moveInterval: enemyMoveInterval('ugg', gs.sm), hops: 0, falling: false,
                    willHatch: false, spawnAnimTimer: e.timer + 20, destRow: null, destCol: null, dirBits: null });
            } else if (ft === 'wrongway') {
                enemyInits.push({ type: 'wrongway', row: ROWS-1, col: 0, jumping: false, jumpT: 0,
                    jumpDur: ENEMY_JUMP_DUR * gs.sm, moveTimer: 0,
                    moveInterval: enemyMoveInterval('wrongway', gs.sm), hops: 0, falling: false,
                    willHatch: false, spawnAnimTimer: e.timer + 20, destRow: null, destCol: null, dirBits: null });
            } else {
                // egg/redball: spawns at col 0 or col 1 — add both as separate enemies
                for (var sc = 0; sc < 2; sc++) {
                    enemyInits.push({ type: ft, row: 1, col: sc, jumping: false, jumpT: 0,
                        jumpDur: ENEMY_JUMP_DUR * gs.sm, moveTimer: 0,
                        moveInterval: enemyMoveInterval(ft, gs.sm), hops: 0, falling: false,
                        willHatch: false, spawnAnimTimer: e.timer + 20, destRow: null, destCol: null, dirBits: null });
                }
            }
            continue;
        }
        enemyInits.push({ type: e.type, row: e.row, col: e.col,
            jumping: !!e.jumping, jumpT: e.jumpT || 0,
            jumpDur: e.jumpDur || ENEMY_JUMP_DUR * gs.sm,
            moveTimer: e.moveTimer || 0,
            moveInterval: e.moveInterval || enemyMoveInterval(e.type, gs.sm),
            hops: e.hops || 0, falling: !!e.falling, willHatch: !!e.willHatch,
            spawnAnimTimer: e.spawnAnimTimer || 0,
            destRow: e.destRow != null ? e.destRow : null,
            destCol: e.destCol != null ? e.destCol : null,
            dirBits: e.dirBits != null ? e.dirBits : null });
    }

    // Prune enemies too far to matter — Manhattan distance > DEPTH means it can't reach
    var pRow = gs.player.row, pCol = gs.player.col;
    var pruned = [];
    for (var pi = 0; pi < enemyInits.length; pi++) {
        var pe = enemyInits[pi];
        var eR = pe.jumping && pe.destRow != null ? pe.destRow : pe.row;
        var eC = pe.jumping && pe.destCol != null ? pe.destCol : pe.col;
        var dist = Math.abs(eR - pRow) + Math.abs(eC - pCol);
        if (dist <= DEPTH + 3) pruned.push(pe);
    }
    enemyInits = pruned;

    // Adaptive depth: reduce when many enemies to avoid timeouts
    if (enemyInits.length >= 6) DEPTH = Math.min(DEPTH, 4);
    else if (enemyInits.length >= 5) DEPTH = Math.min(DEPTH, 5);
    else if (enemyInits.length >= 4) DEPTH = Math.min(DEPTH, 6);

    // ── Factored per-enemy pre-filter: O(N) quick rejection ────────────────────
    // If any single enemy guarantees death, skip expensive full expectimax.
    function perEnemySurvival(gsBase, dir) {
        var _savedRng = simRng;
        var _savedQ = simHopDecisionQ;
        var _savedIdx = simHopDecisionIdx;
        var surv = 1.0;
        for (var pei = 0; pei < gsBase.enemies.length; pei++) {
            var pe = gsBase.enemies[pei];
            if (pe.type === 'slick' || pe.type === 'greenball') continue;
            var gsSingle = simSurvivalClone(gsBase);
            gsSingle.enemies = [simSurvivalClone(gsBase).enemies[pei]];
            gsSingle.survivalOnly = true;
            if (pe.type === 'coily' || pe.dirBits != null || pe.type === 'spawn-timer') {
                simHopDecisionQ = []; simHopDecisionIdx = 0;
                simRng = createSeededRng(42);
                surv *= simStepSurvival(gsSingle, dir) ? 1.0 : 0.0;
            } else {
                var safe = 0;
                for (var pc = 0; pc < 2; pc++) {
                    var gsc = simSurvivalClone(gsSingle);
                    gsc.survivalOnly = true;
                    simHopDecisionQ = [pc]; simHopDecisionIdx = 0;
                    simRng = createSeededRng(42);
                    if (simStepSurvival(gsc, dir)) safe++;
                }
                surv *= safe / 2;
            }
            if (surv <= 0) break;
        }
        // Restore globals: perEnemySurvival changes simRng + simHopDecisionQ
        // for each per-enemy test. Must restore to avoid polluting tour cost
        // computation and game loop.
        simRng = _savedRng;
        simHopDecisionQ = _savedQ;
        simHopDecisionIdx = _savedIdx;
        return surv;
    }

    // ── Expectimax search using simStepForced ──────────────────────────────────
    // Full combo enumeration via game engine. Pre-filtered by perEnemySurvival.
    // Save/restore for zero-allocation undo.

    var _allZeros = [0,0,0,0,0,0,0,0];
    var _allOnes = [1,1,1,1,1,1,1,1];

    function saveGS(gs) {
        var p = gs.player, ne = gs.enemies.length;
        var es = gs.enemies.slice();
        var eSnap = new Array(ne);
        for (var i = 0; i < ne; i++) {
            var e = es[i];
            eSnap[i] = e.type === 'spawn-timer'
                ? [e.type, e.timer, e.forcedType]
                : [e.type, e.row, e.col, e.jumping, e.jumpT, e.jumpDur,
                   e.destRow, e.destCol, e.jumpSrcRow, e.jumpSrcCol,
                   e.moveTimer, e.moveInterval, e.falling, e.willHatch,
                   e.hops, e.spawnAnimTimer, e.dirBits, e.lureRow, e.lureCol];
        }
        var dSnap = new Array(gs.discs.length);
        for (var i2 = 0; i2 < gs.discs.length; i2++) dSnap[i2] = gs.discs[i2].active;
        return [p.row, p.col, p.prevRow, p.prevCol, p.jumping, p.jumpT,
                p.destRow, p.destCol, p.jumpSrcRow, p.jumpSrcCol, p.dead, p.deathTimer,
                gs.alive, gs.freezeTimer, gs.score, gs.levelWon, gs.cubesColored,
                es, eSnap, dSnap];
    }

    function restoreGS(gs, sn) {
        var p = gs.player;
        p.row=sn[0]; p.col=sn[1]; p.prevRow=sn[2]; p.prevCol=sn[3];
        p.jumping=sn[4]; p.jumpT=sn[5]; p.destRow=sn[6]; p.destCol=sn[7];
        p.jumpSrcRow=sn[8]; p.jumpSrcCol=sn[9]; p.dead=sn[10]; p.deathTimer=sn[11];
        gs.alive=sn[12]; gs.freezeTimer=sn[13]; gs.score=sn[14];
        gs.levelWon=sn[15]; gs.cubesColored=sn[16];
        gs.enemies = sn[17];
        var eSnap = sn[18], dSnap = sn[19];
        for (var i = 0; i < dSnap.length; i++) gs.discs[i].active = dSnap[i];
        for (var i2 = 0; i2 < eSnap.length; i2++) {
            var e = gs.enemies[i2], s = eSnap[i2];
            if (s[0] === 'spawn-timer') { e.timer=s[1]; e.forcedType=s[2]; continue; }
            e.type=s[0]; e.row=s[1]; e.col=s[2]; e.jumping=s[3]; e.jumpT=s[4];
            e.jumpDur=s[5]; e.destRow=s[6]; e.destCol=s[7];
            e.jumpSrcRow=s[8]; e.jumpSrcCol=s[9]; e.moveTimer=s[10]; e.moveInterval=s[11];
            e.falling=s[12]; e.willHatch=s[13]; e.hops=s[14];
            e.spawnAnimTimer=s[15]; e.dirBits=s[16]; e.lureRow=s[17]; e.lureCol=s[18];
        }
    }

    function expectimax(gs, depth) {
        if (depth <= 0 || gs.levelWon) return 1.0;
        if (!gs.alive) return 0.0;
        if (typeof performance !== 'undefined' && performance.now() > _dirDeadline) return 1.0;
        var fullEnum = (depth >= DEPTH - 2);
        var N = fullEnum ? Math.min(countRandomDeciders(gs), 4) : 0;
        var combos = fullEnum ? (1 << N) : 2;
        var bestProb = 0;
        for (var dk = 0; dk < DIR_KEYS_WITH_STAY.length; dk++) {
            var dir = DIR_KEYS_WITH_STAY[dk];
            if (!simCanMove(gs, dir)) continue;
            var prob = 0;
            for (var combo = 0; combo < combos; combo++) {
                var choices;
                if (fullEnum) {
                    choices = [];
                    for (var b = 0; b < N; b++) choices.push((combo >> b) & 1);
                } else {
                    choices = combo === 0 ? _allZeros : _allOnes;
                }
                var snap = saveGS(gs);
                simStepForced(gs, dir, choices);
                if (gs.alive) {
                    prob += expectimax(gs, depth - 1) / combos;
                }
                restoreGS(gs, snap);
            }
            if (prob > bestProb) bestProb = prob;
        }
        return bestProb;
    }

    function expectimaxDir(gs, dir, depth) {
        if (!simCanMove(gs, dir)) return 0;
        var N = countRandomDeciders(gs);
        var combos = 1 << Math.min(N, 4);
        var prob = 0;
        for (var combo = 0; combo < combos; combo++) {
            var choices = [];
            for (var b = 0; b < N; b++) choices.push((combo >> b) & 1);
            var snap = saveGS(gs);
            simStepForced(gs, dir, choices);
            if (gs.alive) {
                prob += expectimax(gs, depth - 1) / combos;
            }
            restoreGS(gs, snap);
        }
        return prob;
    }

    // (saveGS, restoreGS, expectimax, expectimaxDir defined above)

    function expectimax(gs, depth) {
        if (depth <= 0 || gs.levelWon) return 1.0;
        if (!gs.alive) return 0.0;
        if (typeof performance !== 'undefined' && performance.now() > _dirDeadline) return 1.0;

        var fullEnum = (depth >= DEPTH - 2);
        var N = fullEnum ? Math.min(countRandomDeciders(gs), 4) : 0;
        var combos = fullEnum ? (1 << N) : 2;
        var bestProb = 0;

        for (var dk = 0; dk < DIR_KEYS_WITH_STAY.length; dk++) {
            var dir = DIR_KEYS_WITH_STAY[dk];
            if (!simCanMove(gs, dir)) continue;

            var prob = 0;
            for (var combo = 0; combo < combos; combo++) {
                var choices;
                if (fullEnum) {
                    choices = [];
                    for (var b = 0; b < N; b++) choices.push((combo >> b) & 1);
                } else {
                    choices = combo === 0 ? _allZeros : _allOnes;
                }
                var snap = saveGS(gs);
                simStepForced(gs, dir, choices);
                if (gs.alive) {
                    prob += expectimax(gs, depth - 1) / combos;
                }
                restoreGS(gs, snap);
            }
            if (prob > bestProb) bestProb = prob;
        }
        return bestProb;
    }

    // Top-level: P(survive depth hops | forced first direction)
    function expectimaxDir(gs, dir, depth) {
        if (!simCanMove(gs, dir)) return 0;
        var N = countRandomDeciders(gs);
        var combos = 1 << Math.min(N, 4);
        var prob = 0;
        for (var combo = 0; combo < combos; combo++) {
            var choices = [];
            for (var b = 0; b < N; b++) choices.push((combo >> b) & 1);
            var snap = saveGS(gs);
            simStepForced(gs, dir, choices);
            if (gs.alive) {
                prob += expectimax(gs, depth - 1) / combos;
            }
            restoreGS(gs, snap);
        }
        return prob;
    }

    // ── Disc lure: when Coily is active, find nearest disc for luring ──
    // If player moves toward a disc and takes it with Coily nearby, Coily dies
    // and we get a long peaceful window. Reduce tour cost for disc-approaching dirs.
    var lureDisc = null, lureDiscAdj = null, lureDiscDist = 999;
    if (coilyInit && coilyInit.row >= 0) {
        for (var ldi = 0; ldi < gs.discs.length; ldi++) {
            var ld = gs.discs[ldi];
            if (!ld.active) continue;
            var laR = ld.row, laC = ld.side === 0 ? 0 : ld.row;
            var ldist = exBfsDist(gs.player.row, gs.player.col, laR, laC);
            if (ldist < lureDiscDist) {
                lureDiscDist = ldist;
                lureDisc = ld;
                lureDiscAdj = { row: laR, col: laC };
            }
        }
        // Only lure on toggle levels (L3+) where peaceful windows are critical,
        // and only if disc is reasonably reachable and Coily is close enough to follow
        var coilyPlayerDist = exBfsDist(coilyInit.row, coilyInit.col, gs.player.row, gs.player.col);
        if (gs.lv < 3 || lureDiscDist > 7 || coilyPlayerDist > 10) lureDisc = null;
    }

    // ── Core: survival tree safety check + strategy-aware tour cost per direction ──

    var safe1 = {};
    var safe2 = {};
    var tourCosts = {};
    var hop1Surv = {};

    for (var k = 0; k < DIR_KEYS_WITH_STAY.length; k++) {
        var dir = DIR_KEYS_WITH_STAY[k];
        if (!simCanMove(gs, dir)) continue;
        // Per-direction deadline: each direction gets fair share of remaining time
        var _perDirMs = window._headlessTest ? 80 : 30;
        _dirDeadline = typeof performance !== 'undefined' ? performance.now() + _perDirMs : Infinity;

        // Don't waste discs when there's no Coily
        if (!coilyActive && dir !== 'STAY') {
            var dd = DIRS[dir];
            var dnr = gs.player.row + dd.dr, dnc = gs.player.col + dd.dc;
            if (!isValidPos(dnr, dnc)) continue;
        }

        // L5+ disc parity check
        if (gs.lv >= 5 && dir !== 'STAY') {
            var dpd = DIRS[dir];
            var dpnr = gs.player.row + dpd.dr, dpnc = gs.player.col + dpd.dc;
            if (!isValidPos(dpnr, dpnc)) {
                var dpDiscRow = -1;
                for (var dpi = 0; dpi < gs.discs.length; dpi++) {
                    var dpc = gs.discs[dpi];
                    if (!dpc.active) continue;
                    if ((dpc.side === 0 && dir === 'UL' && gs.player.col === 0 && gs.player.row === dpc.row) ||
                        (dpc.side === 1 && dir === 'UR' && gs.player.col === gs.player.row && gs.player.row === dpc.row))
                        dpDiscRow = dpc.row;
                }
                if (dpDiscRow >= 0 && dpDiscRow % 2 === 0) {
                    var dcW = 0, dcB = 0;
                    for (var dci3 = 0; dci3 < gs.cubes.length; dci3++) {
                        var dcDef = (gs.tgt - gs.cubes[dci3].state + 3) % 3;
                        if (gs.cubes[dci3].row % 2 === 0) dcW += dcDef; else dcB += dcDef;
                    }
                    dcW = ((dcW - 1) % 3 + 3) % 3;
                    if (((dcW - dcB) % 3 + 3) % 3 === 1) continue;
                }
            }
        }

        // Level-completing move: if this direction lands on a cube whose stomp
        // finishes the level, survival after landing is irrelevant.
        var isLevelComplete = false;
        if (dir !== 'STAY') {
            var lcd = DIRS[dir];
            var lcr = gs.player.row + lcd.dr, lcc = gs.player.col + lcd.dc;
            if (isValidPos(lcr, lcc)) {
                var lcStompsAfter = 0;
                for (var lci = 0; lci < gs.cubes.length; lci++) {
                    var lcc2 = gs.cubes[lci];
                    var sn = stompsNeeded(lcc2.state, gs.lv);
                    if (lcc2.row === lcr && lcc2.col === lcc) sn = Math.max(0, sn - 1); // this cube gets stomped
                    lcStompsAfter += sn;
                }
                if (lcStompsAfter === 0) isLevelComplete = true;
            }
        }

        // Hybrid survival: O(N) per-enemy pre-filter + full expectimax.
        // Pre-filter quickly rejects obviously fatal moves (any single enemy kills).
        // Full expectimax via simStepForced enumerates all enemy combos accurately.
        var survProb = 1.0;
        var maxDepth = (dir === 'STAY') ? Math.min(DEPTH, 3) : DEPTH;
        if (hasEnemies && maxDepth > 0 && !isLevelComplete) {
            // Quick per-enemy pre-filter: if any single enemy kills, skip expectimax
            var quickSurv = perEnemySurvival(gs, dir);
            if (quickSurv <= 0) {
                survProb = 0;
            } else {
                // Full expectimax with iterative deepening
                gs.survivalOnly = true;
                var _expRng = simRng;
                simRng = function() { return 0.5; };
                for (var idDepth = 2; idDepth <= maxDepth; idDepth += 2) {
                    if (idDepth > 2 && typeof performance !== 'undefined' && performance.now() > _dirDeadline) break;
                    survProb = expectimaxDir(gs, dir, idDepth);
                    if (survProb <= 0) break;
                }
                simRng = _expRng;
                gs.survivalOnly = false;
            }
        }
        hop1Surv[dir] = survProb;


        // Compute tour cost — if simStep dies on this RNG seed, use current state estimate
        simSeed(k * 100);
        var tcClone = simDeepClone(gs);
        var tcAlive = simStep(tcClone, dir);
        var tc;
        if (tcAlive) {
            tc = tcClone.levelWon ? 0 : simTourCost(tcClone);
            // Level-completing move: override survival to 1.0 — no need to survive
            // 8 more hops when the level ends on landing
            if (tcClone.levelWon) { survProb = 1.0; hop1Surv[dir] = 1.0; }
        } else {
            tc = simTourCost(gs) + 1; // simStep failed with this seed; approximate
        }
        // STAY penalty: escalates with consecutive STAYs, much higher during freeze
        // (freeze = enemies can't move, so STAY wastes the safe window)
        var stayPenalty = 5 + aiStayCount * 3;
        if (gs.freezeTimer > 0) stayPenalty += 20;
        if (dir === 'STAY') tc += stayPenalty;

        // Anti-oscillation: on toggle levels with excessive hops, penalize
        // directions that land on completed cubes (prevents undo/redo cycles)
        if (gs.lv >= 3 && dir !== 'STAY' && typeof hops !== 'undefined' && hops > 200) {
            var aod = DIRS[dir];
            var aor = gs.player.row + aod.dr, aoc = gs.player.col + aod.dc;
            if (isValidPos(aor, aoc)) {
                for (var aoi = 0; aoi < gs.cubes.length; aoi++) {
                    if (gs.cubes[aoi].row === aor && gs.cubes[aoi].col === aoc && gs.cubes[aoi].state >= gs.tgt) {
                        tc += 10 + Math.floor(hops / 100) * 5; // 15 at 200 hops, 20 at 300, etc.
                        break;
                    }
                }
            }
        }

        // Disc lure bonus: reduce tour cost for directions moving toward disc
        // Luring Coily = long peaceful window (~6 hops of safe progress)
        if (lureDisc && dir !== 'STAY') {
            var dd2 = DIRS[dir];
            var lnr = gs.player.row + dd2.dr, lnc = gs.player.col + dd2.dc;
            if (isValidPos(lnr, lnc) && lureDiscAdj) {
                var distBefore = exBfsDist(gs.player.row, gs.player.col, lureDiscAdj.row, lureDiscAdj.col);
                var distAfter = exBfsDist(lnr, lnc, lureDiscAdj.row, lureDiscAdj.col);
                if (distAfter < distBefore) {
                    var coilyDist = exBfsDist(coilyInit.row, coilyInit.col, gs.player.row, gs.player.col);
                    var lureBonus = coilyDist <= 3 ? 15 : (coilyDist <= 5 ? 10 : 5);
                    tc -= lureBonus;
                }
            } else if (!isValidPos(lnr, lnc)) {
                // Disc-jump direction: if this rides a disc with Coily active, big bonus
                // (simStep handles the ride, but tc doesn't reflect the peaceful window)
                for (var dji = 0; dji < gs.discs.length; dji++) {
                    var djd = gs.discs[dji];
                    if (!djd.active) continue;
                    if ((djd.side === 0 && dir === 'UL' && gs.player.col === 0 && gs.player.row === djd.row) ||
                        (djd.side === 1 && dir === 'UR' && gs.player.col === gs.player.row && gs.player.row === djd.row)) {
                        tc -= 15;
                        break;
                    }
                }
            }
        }


        tourCosts[dir] = tc;

        // Combined score: P(survive)^SAFETY_EXP × discount^tour_cost
        // SAFETY_EXP < 1 compresses probabilities toward 1 (less risk-averse)
        // DISCOUNT < 1 penalizes longer tours (each extra hop = more danger)
        // PROB_FLOOR: minimum probability to consider (below = give up)
        // Score = log(P_per_hop) - λ × tour_cost
        // log(P_per_hop) = log(P_D) / D normalizes danger across depths.
        // λ controls how much tour progress matters vs survival.
        var LAMBDA = window.AI_LAMBDA || 0.002;
        var logPerHop = survProb > 0 ? Math.log(survProb) / DEPTH : -100;
        var score = logPerHop - LAMBDA * tc;
        if (survProb <= 0) {
            aiMoveScores[dir] = -10000;
            continue;
        }
        safe1[dir] = true;
        safe2[dir] = true;
        aiMoveScores[dir] = Math.round(score * 10000);
    }

    // Safety-first: if any direction has P=1.0, never gamble on P<1.0.
    // At corner positions (≤2 valid exits), exclude STAY from triggering this rule —
    // STAY=1.0 at corners leads to horizon traps where enemies converge beyond lookahead.
    var validExits = 0;
    for (var vk = 0; vk < DIR_KEYS.length; vk++) {
        var vd = DIRS[DIR_KEYS[vk]];
        if (isValidPos(gs.player.row + vd.dr, gs.player.col + vd.dc)) validExits++;
    }
    var isCorner = (validExits <= 2);
    var hasPerfect = false;
    for (var sk in hop1Surv) {
        if (isCorner && sk === 'STAY') continue;
        if (hop1Surv[sk] >= 1.0 && aiMoveScores[sk] !== undefined) { hasPerfect = true; break; }
    }
    if (hasPerfect) {
        for (var sk2 in hop1Surv) {
            if (hop1Surv[sk2] < 1.0 && aiMoveScores[sk2] !== undefined && aiMoveScores[sk2] > -10000) {
                aiMoveScores[sk2] = -10000;
            }
        }
    }

    aiLastHop1Surv = hop1Surv;
    aiLastTourCosts = tourCosts;
    aiLureTarget = lureDiscAdj; // export for viz

    // Slick pursuit on toggle levels — catch them if adjacent and safe
    if (gs.lv >= 3) {
        for (var si2 = 0; si2 < gs.enemies.length; si2++) {
            var se = gs.enemies[si2];
            if (se.type !== 'slick') continue;
            var spos = enemyEffectivePos(se);
            for (var sk = 0; sk < DIR_KEYS.length; sk++) {
                var sdk = DIRS[DIR_KEYS[sk]];
                var snr = gs.player.row + sdk.dr, snc = gs.player.col + sdk.dc;
                if (snr === spos.row && snc === spos.col) {
                    if (safe1[DIR_KEYS[sk]] && safe2[DIR_KEYS[sk]] && aiMoveScores[DIR_KEYS[sk]] > -10000) {
                        restoreRng(); return DIR_KEYS[sk];
                    }
                }
            }
        }
    }

    // Pick direction with best combined score (survival prob × tour value)
    var bestDir = null, bestScore = -Infinity;
    for (var fk = 0; fk < DIR_KEYS_WITH_STAY.length; fk++) {
        var fd = DIR_KEYS_WITH_STAY[fk];
        if (aiMoveScores[fd] === undefined) continue;
        if (aiMoveScores[fd] > bestScore) { bestScore = aiMoveScores[fd]; bestDir = fd; }
    }
    restoreRng();
    var _perfMs = typeof performance !== 'undefined' ? performance.now() - _perfStart : 0;
    if (_perfMs > 100) console.log('AI SLOW: ' + _perfMs.toFixed(0) + 'ms, enemies=' + enemyInits.length + ' memo=' + _persistMemoCount + ' pos=(' + gs.player.row + ',' + gs.player.col + ') dir=' + (bestDir||'?'));

    return bestDir || 'STAY';
}

// ─── Main entry point ────────────────────────────────────────────────────────
var aiMoveScores = {};  // exported per-direction scores for viz
var aiLastTourCosts = {};  // last per-direction tour costs from unifiedPick
var aiLastHop1Surv = {};   // last hop-1 survival rates from unifiedPick
var aiLureTarget = null;   // disc-adjacent position being targeted for lure {row,col}
var aiMode = 0;         // 0 = no AI, 1 = unified (always set to 1 now)
var aiStayCount = 0;    // consecutive STAY decisions — used to break stuck loops
var aiLastPos = '';     // last position key — used to detect oscillation
var aiSamePosCount = 0; // frames spent on same tile
var aiLastRemaining = 99; // cubes remaining last time we checked
var aiBestRemaining = 99; // historical best (lowest) remaining — only reset on new best
var aiNoProgressCount = 0; // moves without reducing remaining cubes
var aiPosHistory = [];  // recent position history for oscillation detection
var AI_HISTORY_LEN = 12; // how many positions to track

function aiPickBestDir() {
    // Save game RNG — ALL AI simulation must use seeded RNG, never Math.random
    var savedGameRng = simRng;

    var coilyActive = false;
    for (var i = 0; i < enemies.length; i++) {
        if (enemies[i].type === 'coily') coilyActive = true;
        if (enemies[i].type === 'egg' && (enemies[i].willHatch || (enemies[i].hops || 0) >= 5)) coilyActive = true;
    }

    var gs = simCloneGameState();
    // When enemies are disabled via UI, clear them so AI ignores them
    if (typeof enemiesEnabled !== 'undefined' && !enemiesEnabled) {
        gs.enemies = [];
        coilyActive = false;
    }
    aiMoveScores = {};
    aiMode = 1;

    // Track how long we've been on the same tile
    var posKey = gs.player.row + ',' + gs.player.col;
    if (posKey === aiLastPos) aiSamePosCount++;
    else { aiSamePosCount = 0; aiLastPos = posKey; }

    // Track last visit time for each cube (for oscillation-aware tour planning)
    var curIdx = posToIdx[gs.player.row * ROWS + gs.player.col];
    if (curIdx >= 0) aiCubeLastVisit[curIdx] = typeof hops !== 'undefined' ? hops : 0;

    // Track progress: count remaining cubes
    var tgt = gs.tgt;
    var curRemaining = 0;
    for (var ci = 0; ci < gs.cubes.length; ci++)
        if (gs.cubes[ci].state < tgt) curRemaining++;
    aiLastRemaining = curRemaining;
    if (curRemaining < aiBestRemaining) {
        // Real progress — new historical best
        aiBestRemaining = curRemaining;
        aiNoProgressCount = 0;
    } else if (gs.lv >= 3 && curRemaining > aiBestRemaining) {
        // Toggle level: remaining went UP past best — count faster
        aiNoProgressCount += 2;
    } else {
        aiNoProgressCount++;
    }

    // Track cube reverts on toggle levels — detect which cubes keep getting churned
    if (gs.lv >= 3 && aiPrevCubeStates) {
        for (var ri = 0; ri < gs.cubes.length; ri++) {
            var cube = gs.cubes[ri];
            if (aiPrevCubeStates[ri] >= tgt && cube.state < tgt) {
                // This cube was completed but got reverted
                var ridx = posToIdx[cube.row * ROWS + cube.col];
                if (ridx >= 0) aiRevertCounts[ridx] = Math.min(aiRevertCounts[ridx] + 1, 10);
            }
        }
    }
    // Save current states for next comparison
    aiPrevCubeStates = new Int8Array(gs.cubes.length);
    for (var si = 0; si < gs.cubes.length; si++) aiPrevCubeStates[si] = gs.cubes[si].state;

    var result = unifiedPick(gs, coilyActive);
    var _origResult = result;

    // Validate: if danger table predicts P=1.0, run simStep to verify
    if (window._predValidate && result && result !== 'STAY' && aiLastHop1Surv && aiLastHop1Surv[result] !== undefined) {
        var _predP = aiLastHop1Surv[result];
        if (_predP >= 0.99) {
            var _savedRng = simRng;
            var _savedQ = simHopDecisionQ, _savedIdx = simHopDecisionIdx;
            simHopDecisionQ = null; // use simRng fallback
            for (var _sd = 0; _sd < 4; _sd++) {
                var _vgs = simDeepClone(gs);
                _vgs.survivalOnly = true;
                simRng = createSeededRng(_sd * 1000 + 7);
                if (!simStep(_vgs, result)) {
                    // Pre-death state for debugging
                    var _preStr = '';
                    var _preGs = simDeepClone(gs);
                    for (var _pi = 0; _pi < _preGs.enemies.length; _pi++) {
                        var _pe = _preGs.enemies[_pi];
                        if (_pe.type === 'spawn-timer') continue;
                        _preStr += ' ' + _pe.type + '@(' + _pe.row + ',' + _pe.col + ')';
                        if (_pe.jumping) _preStr += '→(' + _pe.destRow + ',' + _pe.destCol + ')j' + (_pe.jumpT||0).toFixed(2);
                        _preStr += 'mt' + (_pe.moveTimer||0) + '/' + (_pe.moveInterval||0);
                    }
                    console.log('PRE-STATE ' + _preStr);
                    // Died — report details
                    var _killer = _vgs.deathEnemy || '?';
                    // Find the enemy that killed — search for one at player pos
                    var _killerPos = '';
                    for (var _vi = 0; _vi < _vgs.enemies.length; _vi++) {
                        var _ve = _vgs.enemies[_vi];
                        if (_ve.type === _killer) {
                            _killerPos = '@(' + _ve.row + ',' + _ve.col + ')';
                            if (_ve.jumping) _killerPos += 'j' + (_ve.jumpT||0).toFixed(2);
                            break;
                        }
                    }
                    var _pPos = '(' + _vgs.player.row + ',' + _vgs.player.col + ')';
                    if (_vgs.player.jumping) _pPos += 'j' + (_vgs.player.jumpT||0).toFixed(2);
                    console.log('PRED-FAIL @(' + gs.player.row + ',' + gs.player.col + ') dir=' + result +
                        ' seed=' + _sd + ' killer=' + _killer + _killerPos + ' player=' + _pPos);
                    break;
                }
            }
            simRng = _savedRng;
            simHopDecisionQ = _savedQ; simHopDecisionIdx = _savedIdx;
        }
    }

    // Record decision history for death diagnosis
    if (!window._aiDecisionLog) window._aiDecisionLog = [];
    var enemySnap = '';
    for (var dli = 0; dli < gs.enemies.length; dli++) {
        var dle = gs.enemies[dli];
        if (dle.type === 'spawn-timer') continue;
        enemySnap += ' ' + dle.type + '@(' + dle.row + ',' + dle.col + ')';
        if (dle.spawnAnimTimer > 0) enemySnap += 'sa' + dle.spawnAnimTimer;
        else if (dle.jumping) enemySnap += 'j' + (dle.jumpT||0).toFixed(2) + '→(' + dle.destRow + ',' + dle.destCol + ')';
        else enemySnap += 't' + (dle.moveTimer||0);
    }
    var probSnap = '';
    for (var dlk in aiLastHop1Surv) probSnap += ' ' + dlk + '=' + (aiLastHop1Surv[dlk] !== undefined ? aiLastHop1Surv[dlk].toFixed(3) : '?');
    window._aiDecisionLog.push({
        hop: typeof hops !== 'undefined' ? hops : 0,
        pos: '(' + gs.player.row + ',' + gs.player.col + ')',
        dir: result,
        probs: probSnap.trim(),
        enemies: enemySnap.trim(),
        scores: JSON.parse(JSON.stringify(aiMoveScores))
    });
    if (window._aiDecisionLog.length > 80) window._aiDecisionLog.shift();

    // Track position history for oscillation detection
    aiPosHistory.push(posKey);
    if (aiPosHistory.length > AI_HISTORY_LEN) aiPosHistory.shift();

    // Detect oscillation: A-B-A or A-B-C-A-B-C patterns
    // Skip override if result leads to an unfinished cube (tour planner's target)
    var destIsUnfinished = false;
    if (result !== 'STAY' && gs.lv >= 3) {
        var dd = DIRS[result];
        var ddr = gs.player.row + dd.dr, ddc = gs.player.col + dd.dc;
        for (var dci = 0; dci < gs.cubes.length; dci++) {
            if (gs.cubes[dci].row === ddr && gs.cubes[dci].col === ddc && gs.cubes[dci].state < gs.tgt) {
                destIsUnfinished = true; break;
            }
        }
    }
    if (result !== 'STAY' && !destIsUnfinished && aiPosHistory.length >= 3) {
        var h = aiPosHistory;
        var len = h.length;
        var oscillating = false;
        // A-B-A pattern (2-cycle)
        if (len >= 3 && h[len-1] === h[len-3] && h[len-1] !== h[len-2]) oscillating = true;
        // A-B-C-A-B-C pattern (3-cycle)
        if (len >= 6 && h[len-1] === h[len-4] && h[len-2] === h[len-5] && h[len-3] === h[len-6]) oscillating = true;
        // A-B-C-D-A-B-C-D pattern (4-cycle)
        if (len >= 8 && h[len-1] === h[len-5] && h[len-2] === h[len-6] && h[len-3] === h[len-7] && h[len-4] === h[len-8]) oscillating = true;
        // General: count unique tiles in recent history — if very few, we're looping
        if (len >= 8) {
            var uniqueTiles = {};
            for (var ui = len - 8; ui < len; ui++) uniqueTiles[h[ui]] = true;
            var uniqueCount = 0;
            for (var uk in uniqueTiles) uniqueCount++;
            if (uniqueCount <= 3) oscillating = true;
        }

        if (oscillating) {
            var d = DIRS[result];
            var destKey = (gs.player.row + d.dr) + ',' + (gs.player.col + d.dc);
            var recentTiles = {};
            for (var ri = Math.max(0, len - 4); ri < len; ri++) recentTiles[h[ri]] = true;
            if (recentTiles[destKey]) {
                // Build completed cube set for revert avoidance
                var completedCubes = {};
                if (gs.lv >= 3) {
                    for (var cci = 0; cci < gs.cubes.length; cci++)
                        if (gs.cubes[cci].state >= gs.tgt) completedCubes[gs.cubes[cci].row + ',' + gs.cubes[cci].col] = true;
                }
                var altDir = null, altScore = -Infinity;
                for (var ak = 0; ak < DIR_KEYS.length; ak++) {
                    if (DIR_KEYS[ak] === result) continue;
                    if (!simCanMove(gs, DIR_KEYS[ak])) continue;
                    var ad = DIRS[DIR_KEYS[ak]];
                    var aKey = (gs.player.row + ad.dr) + ',' + (gs.player.col + ad.dc);
                    if (recentTiles[aKey]) continue;
                    var asc = aiMoveScores[DIR_KEYS[ak]];
                    // Only accept moves that haven't been demoted (not blocked or gamble)
                    if (asc !== undefined && asc <= -10000) continue;
                    // At level 3+: avoid alternatives that revert completed cubes
                    if (completedCubes[aKey]) continue;
                    if (asc !== undefined && asc > altScore) { altScore = asc; altDir = DIR_KEYS[ak]; }
                }
                // If no non-reverting alternative, allow reverting ones (but still not recent)
                if (!altDir) {
                    for (var ak2 = 0; ak2 < DIR_KEYS.length; ak2++) {
                        if (DIR_KEYS[ak2] === result) continue;
                        if (!simCanMove(gs, DIR_KEYS[ak2])) continue;
                        var ad2 = DIRS[DIR_KEYS[ak2]];
                        var aKey2 = (gs.player.row + ad2.dr) + ',' + (gs.player.col + ad2.dc);
                        if (recentTiles[aKey2]) continue;
                        var asc2 = aiMoveScores[DIR_KEYS[ak2]];
                        if (asc2 !== undefined && asc2 <= -10000) continue;
                        if (asc2 !== undefined && asc2 > altScore) { altScore = asc2; altDir = DIR_KEYS[ak2]; }
                    }
                }
                // Safety guard: don't override if the alternative is substantially
                // less safe than the original. logPerHop difference > 0.02 means
                // per-hop survival drops by >~2% — not worth it to break oscillation.
                if (altDir) {
                    var origScore = aiMoveScores[result];
                    if (origScore !== undefined && origScore > altScore + 200) {
                        altDir = null;
                    }
                }
                if (altDir) { result = altDir; aiPosHistory.length = 0; }
            }
        }
    }

    // Hard stuck breaker: at 500+ hops on toggle levels, directly target nearest
    // unfinished cube regardless of safety — oscillation is worse than a death.
    if (gs.lv >= 3 && typeof hops !== 'undefined' && hops > 500 && result !== 'STAY') {
        var nearestUnf = null, nearestUnfDist = 999;
        for (var nui = 0; nui < gs.cubes.length; nui++) {
            if (gs.cubes[nui].state < gs.tgt) {
                var nud = exBfsDist(gs.player.row, gs.player.col, gs.cubes[nui].row, gs.cubes[nui].col);
                if (nud < nearestUnfDist) { nearestUnfDist = nud; nearestUnf = gs.cubes[nui]; }
            }
        }
        if (nearestUnf) {
            var bfs = bfsTo(gs.player.row, gs.player.col, nearestUnf.row, nearestUnf.col);
            if (bfs && bfs.path.length > 0 && simCanMove(gs, bfs.path[0])) {
                // Only override if the direction isn't fatal
                var bfsScore = aiMoveScores[bfs.path[0]];
                if (bfsScore !== undefined && bfsScore > -10000) result = bfs.path[0];
            }
        }
    }

    // L5+ parity fix: compute (W-B) mod 3 from actual cube states.
    // Unsolvable when (W-B) ≡ 1 mod 3 from even row, or ≡ 2 from odd row.
    // If stuck in bad parity, jump off an odd row to shift it.
    if (gs.lv >= 5 && aiNoProgressCount > 50) {
        var parW = 0, parB = 0;
        for (var pi = 0; pi < gs.cubes.length; pi++) {
            var pdef = (gs.tgt - gs.cubes[pi].state + 3) % 3;
            if (gs.cubes[pi].row % 2 === 0) parW += pdef; else parB += pdef;
        }
        var parGap = ((parW - parB) % 3 + 3) % 3;
        var playerEven = gs.player.row % 2 === 0;
        var parBad = (playerEven && parGap === 1) || (!playerEven && parGap === 2);
        if (parBad && gs.player.row % 2 === 1) {
            // On odd row with bad parity — jump off edge to fix
            for (var fk = 0; fk < DIR_KEYS.length; fk++) {
                var fd = DIRS[DIR_KEYS[fk]];
                var fnr = gs.player.row + fd.dr, fnc = gs.player.col + fd.dc;
                if (!isValidPos(fnr, fnc)) { result = DIR_KEYS[fk]; break; }
                // Also check discs — don't jump onto a disc
                var isDiscJump = false;
                for (var fdi = 0; fdi < gs.discs.length; fdi++) {
                    var fdc = gs.discs[fdi];
                    if (fdc.active && fdc.row === gs.player.row) isDiscJump = true;
                }
                if (!isDiscJump && !isValidPos(fnr, fnc)) { result = DIR_KEYS[fk]; break; }
            }
        } else if (parBad && playerEven) {
            // On even row — need to get to odd row first, then fall
            // Just let the normal AI move to an odd row; the fall will trigger next time
        }
    }

    // No-progress breaker: escalating urgency when stuck without reducing remaining cubes.
    // Phase 1 (>10 moves): try to land on adjacent unfinished cube (safe only)
    // Phase 2 (>20 moves): use tour direction even if not immediately on unfinished cube
    // Phase 3 (>30 moves): accept highest-survival move toward progress (relax 100% safety)
    if (aiNoProgressCount > 10 && result !== 'STAY') {
        var dd3 = DIRS[result];
        var dr3 = gs.player.row + dd3.dr, dc3 = gs.player.col + dd3.dc;
        var destIsUnf3 = false;
        for (var ufi = 0; ufi < gs.cubes.length; ufi++) {
            if (gs.cubes[ufi].row === dr3 && gs.cubes[ufi].col === dc3 && gs.cubes[ufi].state < gs.tgt) {
                destIsUnf3 = true; break;
            }
        }
        if (!destIsUnf3) {
            // Phase 1: find adjacent unfinished cube with safe move
            var bestProgDir = null, bestProgScore = -Infinity;
            for (var pk = 0; pk < DIR_KEYS.length; pk++) {
                if (!simCanMove(gs, DIR_KEYS[pk])) continue;
                var pd = DIRS[DIR_KEYS[pk]];
                var pnr = gs.player.row + pd.dr, pnc = gs.player.col + pd.dc;
                if (!isValidPos(pnr, pnc)) continue;
                for (var pui = 0; pui < gs.cubes.length; pui++) {
                    if (gs.cubes[pui].row === pnr && gs.cubes[pui].col === pnc && gs.cubes[pui].state < gs.tgt) {
                        var psc = aiMoveScores[DIR_KEYS[pk]];
                        if (psc !== undefined && psc > -10000 && psc > bestProgScore) {
                            bestProgScore = psc; bestProgDir = DIR_KEYS[pk];
                        }
                        break;
                    }
                }
            }
            // Phase 2 (>20): pick best safe direction by tour cost
            if (!bestProgDir && aiNoProgressCount > 20) {
                var bestTC = Infinity;
                for (var pk2 = 0; pk2 < DIR_KEYS.length; pk2++) {
                    var pk2sc = aiMoveScores[DIR_KEYS[pk2]];
                    if (pk2sc !== undefined && pk2sc > -10000 && aiLastTourCosts[DIR_KEYS[pk2]] !== undefined) {
                        if (aiLastTourCosts[DIR_KEYS[pk2]] < bestTC) {
                            bestTC = aiLastTourCosts[DIR_KEYS[pk2]];
                            bestProgDir = DIR_KEYS[pk2];
                        }
                    }
                }
            }
            // Phase 3 (>30): pick any safe move
            if (!bestProgDir && aiNoProgressCount > 30) {
                if (gs.lv >= 5) {
                    // BFS avoiding completed cubes to find nearest unfinished
                    var avoidSet = {};
                    for (var avi2 = 0; avi2 < gs.cubes.length; avi2++)
                        if (gs.cubes[avi2].state >= gs.tgt)
                            avoidSet[gs.cubes[avi2].row + ',' + gs.cubes[avi2].col] = true;
                    // Try BFS with avoid set first, then without
                    for (var avoidPass = 0; avoidPass < 2 && !bestProgDir; avoidPass++) {
                        var useAvoid = (avoidPass === 0) ? avoidSet : null;
                        for (var pk3 = 0; pk3 < DIR_KEYS.length; pk3++) {
                            if (!simCanMove(gs, DIR_KEYS[pk3])) continue;
                            var pk3sc = aiMoveScores[DIR_KEYS[pk3]];
                            if (pk3sc === undefined || pk3sc <= -10000) continue;
                            var pk3d = DIRS[DIR_KEYS[pk3]];
                            var pk3r = gs.player.row + pk3d.dr, pk3c = gs.player.col + pk3d.dc;
                            if (!isValidPos(pk3r, pk3c)) continue;
                            // Check if this direction leads toward an unfinished cube
                            var pk3bfs = bfsTo(pk3r, pk3c, -1, -1, useAvoid);
                            // Find nearest unfinished via BFS
                            for (var uf3 = 0; uf3 < gs.cubes.length; uf3++) {
                                if (gs.cubes[uf3].state >= gs.tgt) continue;
                                var uf3path = bfsTo(pk3r, pk3c, gs.cubes[uf3].row, gs.cubes[uf3].col, useAvoid);
                                if (uf3path && (!bestProgDir || uf3path.dist < bestProgScore)) {
                                    bestProgScore = uf3path.dist; bestProgDir = DIR_KEYS[pk3];
                                }
                            }
                        }
                    }
                }
                if (!bestProgDir) {
                    for (var pk3b = 0; pk3b < DIR_KEYS.length; pk3b++) {
                        if (!simCanMove(gs, DIR_KEYS[pk3b])) continue;
                        var pk3bsc = aiMoveScores[DIR_KEYS[pk3b]];
                        if (pk3bsc !== undefined && pk3bsc >= 0) {
                            bestProgDir = DIR_KEYS[pk3b]; break;
                        }
                    }
                }
            }
            // Safety guard: don't override if progress move is much less safe
            if (bestProgDir) {
                var origScoreN = aiMoveScores[result];
                var progScoreN = aiMoveScores[bestProgDir];
                if (origScoreN !== undefined && progScoreN !== undefined && origScoreN > progScoreN + 200) {
                    bestProgDir = null;
                }
            }
            if (bestProgDir) { result = bestProgDir; aiPosHistory.length = 0; }
            // Don't reset aiNoProgressCount here — only reset on actual progress (line ~961)
        }
    }

    // Break stuck STAY loops — only override with equally-safe alternatives
    if (result === 'STAY') {
        aiStayCount++;
        if (aiStayCount >= 3) {
            var stayP = aiLastHop1Surv['STAY'] || 0;
            var bestAlt = null, bestAltScore = -Infinity;
            for (var k = 0; k < DIR_KEYS.length; k++) {
                if (simCanMove(gs, DIR_KEYS[k])) {
                    var sc = aiMoveScores[DIR_KEYS[k]];
                    if (sc === undefined || sc <= -10000) continue;
                    var altP = aiLastHop1Surv[DIR_KEYS[k]] || 0;
                    if (altP < stayP) continue;
                    if (sc > bestAltScore) {
                        bestAltScore = sc; bestAlt = DIR_KEYS[k];
                    }
                }
            }
            if (bestAlt) { result = bestAlt; aiStayCount = 0; }
        }
    } else {
        aiStayCount = 0;
    }

    // Restore game RNG — must never leak seeded RNG into real game
    simRng = savedGameRng;
    if (_origResult !== result && typeof console !== 'undefined') {
        var _origS = aiMoveScores[_origResult], _newS = aiMoveScores[result];
        console.log('AI OVERRIDE @(' + gs.player.row + ',' + gs.player.col + ') orig=' + _origResult + '(' + _origS + ') new=' + result + '(' + _newS + ') np=' + aiNoProgressCount + ' stay=' + aiStayCount);
    }
    return result;
}
