// qbert-ai.js — Q*bert AI: hybrid strategy + survival tree
var AI_VERSION = 'v9.2';
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

    // Simulate Coily for one hop.
    // ROM: Coily chases prevR/prevC. Exception: if at prev, chase pR/pC.
    // When lure is active (disc ride), Coily chases lureRow/lureCol instead.
    // Optional prevR/prevC — defaults to pR/pC (correct for recursive levels).
    function simCoilyHop(pR, pC, nr, nc, coily, prevR, prevC) {
        if (prevR === undefined) { prevR = pR; prevC = pC; }
        var cr = coily.row, cc = coily.col;
        var cj = coily.jumping, ct = coily.jumpT || 0;
        var cm = coily.moveTimer || 0;
        var cdr = coily.destRow, cdc = coily.destCol;
        var hasLure = coily.lureRow != null;
        for (var f = 1; f <= pJumpFrames + 1; f++) {
            var playerT = f * pJumpDur;
            if (cj) {
                ct += cJumpDur;
                if (ct >= 1) {
                    cj = false; ct = 0; cm = 0; cr = cdr; cc = cdc; cdr = null; cdc = null;
                    // Coily fell off during lure chase — it's gone, no more threat
                    if (hasLure && !isValidPos(cr, cc)) {
                        return { row: -99, col: -99, jumping: false, jumpT: 0, moveTimer: 0,
                                 destRow: null, destCol: null, lureRow: null, lureCol: null };
                    }
                }
            } else {
                cm++;
                if (cm >= cIdleFrames) {
                    var chaseR, chaseC;
                    if (hasLure) {
                        chaseR = coily.lureRow; chaseC = coily.lureCol;
                    } else {
                        chaseR = prevR; chaseC = prevC;
                        if (cr === prevR && cc === prevC) { chaseR = pR; chaseC = pC; }
                    }
                    var cn = coilyChaseStep(cr, cc, chaseR, chaseC);
                    if (cn) {
                        cj = true; ct = 0; cm = 0; cdr = cn.row; cdc = cn.col;
                    } else if (hasLure) {
                        // Chase step failed (off grid) — Coily falls off during lure
                        cj = true; ct = 0; cm = 0;
                        cdr = chaseR; cdc = chaseC; // off-grid destination
                    }
                }
            }
            var ptR, ptC;
            if (playerT < 0.33) { ptR = pR; ptC = pC; }
            else if (playerT >= 0.67) { ptR = nr; ptC = nc; }
            else continue;
            var ctR, ctC;
            if (cj) {
                if (ct < 0.33) { ctR = cr; ctC = cc; }
                else if (ct >= 0.67 && cdr != null) { ctR = cdr; ctC = cdc; }
                else { ctR = -99; ctC = -99; }
            } else { ctR = cr; ctC = cc; }
            if (ptR === ctR && ptC === ctC) return null;
            if (f <= pJumpFrames && cj && cdr != null && nr === cr && nc === cc && pR === cdr && pC === cdc) return null;
        }
        return { row: cr, col: cc, jumping: cj, jumpT: ct, moveTimer: cm, destRow: cdr, destCol: cdc,
                 lureRow: hasLure ? coily.lureRow : null, lureCol: hasLure ? coily.lureCol : null };
    }

    // Get possible moves for an enemy type
    function enemyMoves(e) {
        if (e.type === 'egg' || e.type === 'redball') {
            if (e.dirBits != null) { var nc = (e.dirBits & 1) ? e.col+1 : e.col; return [{r:e.row+1,c:nc}]; }
            return [{r:e.row+1,c:e.col}, {r:e.row+1,c:e.col+1}];
        }
        if (e.type === 'ugg') return [{r:e.row-1,c:e.col-1}, {r:e.row,c:e.col-1}];
        if (e.type === 'wrongway') return [{r:e.row-1,c:e.col}, {r:e.row,c:e.col+1}];
        return [];
    }

    // Simulate ONE enemy for one player hop. Returns:
    //   {safeBranches: [{safe, enemy}], totalBranches: N}
    // For deterministic enemies: 1 branch. For random: 2 branches.
    function simOneEnemy(pR, pC, nr, nc, e) {
        var moves = null;
        var isDecider = false;
        if (!e.falling) {
            // Compute frames until this enemy reaches its first decision point
            var framesUntilDecision = Infinity;
            if (e.spawnAnimTimer > 0) {
                framesUntilDecision = e.spawnAnimTimer + e.moveInterval;
            } else if (e.jumping) {
                var framesToLand = Math.ceil((1.0 - e.jumpT) / e.jumpDur);
                framesUntilDecision = framesToLand + e.moveInterval;
            } else {
                framesUntilDecision = e.moveInterval - e.moveTimer;
            }
            if (framesUntilDecision <= pJumpFrames + 1) {
                moves = enemyMoves(e);
                if (moves.length > 1) isDecider = true;
            }
        }
        var numChoices = isDecider ? 2 : 1;
        var results = [];
        for (var ch = 0; ch < numChoices; ch++) {
            // Clone enemy
            var e2 = { type:e.type, row:e.row, col:e.col, jumping:e.jumping,
                jumpT:e.jumpT, jumpDur:e.jumpDur, moveTimer:e.moveTimer,
                moveInterval:e.moveInterval, hops:e.hops, falling:e.falling,
                willHatch:e.willHatch, spawnAnimTimer:e.spawnAnimTimer,
                destRow:e.destRow, destCol:e.destCol,
                dirBits:e.dirBits != null ? e.dirBits : null, _choice: isDecider ? ch : undefined };
            // Pre-move collision (frame 0)
            var safe = true;
            if (e2.spawnAnimTimer <= 0 && e2.type !== 'dead') {
                if (e2.jumping) {
                    if (e2.jumpT < 0.33 && e2.row === pR && e2.col === pC) safe = false;
                    else if (e2.jumpT >= 0.67 && e2.destRow === pR && e2.destCol === pC) safe = false;
                } else if (e2.row === pR && e2.col === pC) safe = false;
            }
            // Frame-by-frame
            for (var f = 1; f <= pJumpFrames + 1 && safe; f++) {
                var playerT = f * pJumpDur;
                // Advance enemy
                if ((e2.falling && !e2.jumping) || e2.type === 'dead') break;
                if (e2.spawnAnimTimer > 0) {
                    e2.spawnAnimTimer--;
                    if (e2.spawnAnimTimer > 0) continue; // still animating, no collision
                    // Just became active — skip movement but fall through to collision check
                } else if (e2.jumping) {
                    e2.jumpT += e2.jumpDur;
                    if (e2.jumpT >= 1) {
                        e2.jumping = false; e2.jumpT = 0; e2.moveTimer = 0;
                        e2.row = e2.destRow; e2.col = e2.destCol;
                        e2.destRow = null; e2.destCol = null;
                        if (!isValidPos(e2.row, e2.col)) e2.falling = true;
                        if (e2.type === 'egg' && (e2.willHatch || e2.hops >= 6)) {
                            e2.type = 'coily'; e2.moveInterval = cIdleFrames;
                        }
                    }
                } else {
                    e2.moveTimer++;
                    if (e2.moveTimer >= e2.moveInterval) {
                        e2.moveTimer = 0;
                        e2.hops = (e2.hops || 0) + 1;
                        if (e2.type === 'coily') {
                            var cn = coilyChaseStep(e2.row, e2.col, pR, pC);
                            if (cn) { e2.jumping = true; e2.jumpT = 0; e2.destRow = cn.row; e2.destCol = cn.col;
                                if (!isValidPos(cn.row, cn.col)) e2.falling = true; }
                        } else {
                            var mvs = enemyMoves(e2);
                            if (mvs.length === 0) continue;
                            var c2 = (e2._choice != null) ? e2._choice : 0;
                            e2._choice = undefined;
                            if (e2.dirBits != null) e2.dirBits = e2.dirBits >> 1;
                            var m = mvs[Math.min(c2, mvs.length - 1)];
                            e2.jumping = true; e2.jumpT = 0; e2.destRow = m.r; e2.destCol = m.c;
                            if (!isValidPos(m.r, m.c)) e2.falling = true;
                            if (e2.type === 'egg' && (e2.hops >= 6 || m.r >= ROWS - 1)) e2.willHatch = true;
                        }
                    }
                }
                // Collision check
                if (e2.spawnAnimTimer > 0 || e2.type === 'dead') continue;
                var ptR, ptC;
                if (playerT < 0.33) { ptR = pR; ptC = pC; }
                else if (playerT >= 0.67) { ptR = nr; ptC = nc; }
                else { ptR = -99; ptC = -99; }
                if (ptR >= 0) {
                    if (e2.jumping) {
                        if (e2.jumpT < 0.33 && e2.row === ptR && e2.col === ptC) safe = false;
                        else if (e2.jumpT >= 0.67 && e2.destRow === ptR && e2.destCol === ptC) safe = false;
                    } else if (e2.row === ptR && e2.col === ptC) safe = false;
                }
                if (f <= pJumpFrames && e2.jumping && e2.destRow != null &&
                    nr === e2.row && nc === e2.col && pR === e2.destRow && pC === e2.destCol) safe = false;
            }
            if (!e2.falling && e2.type !== 'dead') {
                results.push({ safe: safe, enemy: e2 });
            } else {
                results.push({ safe: safe, enemy: null }); // fell off or hatched
            }
        }
        return { branches: results, count: numChoices };
    }

    // Fully factored survival: P(survive) = ∏_i surviveOne(enemy_i).
    // Each enemy is an independent expectimax tree. O(K × states × depth).
    // No joint enumeration, no exponential blowup.
    function surviveOne(pR, pC, coily, enemy, depth) {
        if (depth <= 0) return 1.0;
        var me = enemy;
        var mKey = pR + ',' + pC + '|' + coily.row + ',' + coily.col + ',' +
                   (coily.jumping ? 1 : 0) + ',' + Math.round((coily.jumpT || 0) * 30) + ',' +
                   (coily.moveTimer || 0) + ',' +
                   (coily.destRow != null ? coily.destRow : 9) + ',' +
                   (coily.destCol != null ? coily.destCol : 9) + '|' +
                   me.type[0] + me.row + ',' + me.col + ',' + (me.jumping ? 1 : 0) + ',' +
                   Math.round((me.jumpT || 0) * 30) + ',' + me.moveTimer + ',' +
                   (me.destRow != null ? me.destRow : 9) + ',' + (me.destCol != null ? me.destCol : 9) + ',' +
                   (me.hops || 0) + ',' + (me.dirBits != null ? me.dirBits : 'n') + ',' +
                   (me.spawnAnimTimer || 0) + '|' + depth;
        if (memo.has(mKey)) return memo.get(mKey);

        var bestProb = 0;
        for (var dk = 0; dk < DIR_KEYS_WITH_STAY.length; dk++) {
            var d = DIRS[DIR_KEYS_WITH_STAY[dk]];
            var nr = pR + d.dr, nc = pC + d.dc;
            if (!isValidPos(nr, nc)) continue;
            var newCoily = simCoilyHop(pR, pC, nr, nc, coily);
            if (!newCoily) continue;
            // Simulate this one enemy, average over branches
            var res = simOneEnemy(pR, pC, nr, nc, enemy);
            var prob = 0;
            for (var bi = 0; bi < res.branches.length; bi++) {
                if (res.branches[bi].safe) {
                    var ne = res.branches[bi].enemy;
                    prob += (ne ? surviveOne(nr, nc, newCoily, ne, depth - 1) : 1.0) / res.count;
                }
            }
            if (prob > bestProb) bestProb = prob;
        }
        memo.set(mKey, bestProb); _persistMemoCount++;
        return bestProb;
    }

    // Joint survival: for each direction, compute per-enemy product, take max.
    // max_D [∏_i P_i(D)] — NOT ∏_i [max_D P_i(D)].
    // This ensures one direction must work for ALL enemies simultaneously.
    // The per-enemy future survival (surviveOne) is still factored at depth-1,
    // but the direction constraint at each level is joint.
    function survive(pR, pC, coily, enemies, depth, forcedDir) {
        if (depth <= 0) return 1.0;
        // Per-direction time check — only for deep levels (depth 2 always completes for safety)
        if (depth >= 3 && typeof performance !== 'undefined' && performance.now() > _dirDeadline) return 1.0;
        // Memoize (skip for forced dir — only called once per direction)
        var mKey;
        if (!forcedDir) {
            mKey = pR + ',' + pC + '|' + coily.row + ',' + coily.col + ',' +
                   (coily.jumping ? 1 : 0) + ',' + Math.round((coily.jumpT || 0) * 30) + ',' +
                   (coily.moveTimer || 0) + ',' +
                   (coily.destRow != null ? coily.destRow : 9) + ',' +
                   (coily.destCol != null ? coily.destCol : 9) + '|' + depth;
            for (var mi = 0; mi < enemies.length; mi++) {
                var me = enemies[mi];
                mKey += '|' + me.type[0] + me.row + ',' + me.col + ',' + (me.jumping ? 1 : 0) + ',' +
                        Math.round((me.jumpT || 0) * 30) + ',' + me.moveTimer + ',' +
                        (me.destRow != null ? me.destRow : 9) + ',' + (me.destCol != null ? me.destCol : 9) + ',' +
                        (me.hops || 0) + ',' + (me.dirBits != null ? me.dirBits : 'n') + ',' +
                        (me.spawnAnimTimer || 0);
            }
            if (memo.has(mKey)) return memo.get(mKey);
        }
        var tryDirs = forcedDir ? [forcedDir] : DIR_KEYS_WITH_STAY;
        var bestProb = 0;
        for (var dk = 0; dk < tryDirs.length; dk++) {
            var d = DIRS[tryDirs[dk]];
            var nr = pR + d.dr, nc = pC + d.dc;
            if (!isValidPos(nr, nc)) continue; // disc handled in dirSurvivalProb
            var newCoily = simCoilyHop(pR, pC, nr, nc, coily);
            if (!newCoily) continue;
            // Per-enemy hop safety + collect branches for recursion
            var prob = 1.0;
            var baseEnemies = [];
            var branchEnemies = []; // branching enemies get both branches checked (top 5 levels)
            var doBranch = (depth >= DEPTH - 4);
            for (var ei = 0; ei < enemies.length; ei++) {
                var res = simOneEnemy(pR, pC, nr, nc, enemies[ei]);
                var safeBranches = [];
                for (var bi = 0; bi < res.branches.length; bi++) {
                    if (res.branches[bi].safe) safeBranches.push(res.branches[bi].enemy);
                }
                prob *= safeBranches.length / res.count;
                if (prob <= 0) break;
                if (safeBranches.length === 1) {
                    if (safeBranches[0]) baseEnemies.push(safeBranches[0]);
                } else if (safeBranches.length === 2) {
                    if (doBranch) {
                        branchEnemies.push(safeBranches);
                    } else {
                        // Deeper levels: use first branch only (performance)
                        if (safeBranches[0]) baseEnemies.push(safeBranches[0]);
                    }
                }
            }
            if (prob > 0) {
                if (branchEnemies.length === 0) {
                    prob *= survive(nr, nc, newCoily, baseEnemies, depth - 1);
                } else if (branchEnemies.length <= 3) {
                    // Enumerate all 2^N combinations (up to 8) for joint correctness
                    var nCombo = 1 << branchEnemies.length;
                    var comboSum = 0;
                    for (var ci = 0; ci < nCombo; ci++) {
                        var comboEnemies = baseEnemies.slice();
                        for (var cbi = 0; cbi < branchEnemies.length; cbi++) {
                            var branch = (ci >> cbi) & 1;
                            if (branchEnemies[cbi][branch]) comboEnemies.push(branchEnemies[cbi][branch]);
                        }
                        comboSum += survive(nr, nc, newCoily, comboEnemies, depth - 1);
                    }
                    prob *= comboSum / nCombo;
                } else {
                    // Too many branching enemies — use first branch for extras
                    var limitBranch = branchEnemies.slice(0, 3);
                    for (var ebi = 3; ebi < branchEnemies.length; ebi++) {
                        if (branchEnemies[ebi][0]) baseEnemies.push(branchEnemies[ebi][0]);
                    }
                    var nCombo2 = 1 << limitBranch.length;
                    var comboSum2 = 0;
                    for (var ci2 = 0; ci2 < nCombo2; ci2++) {
                        var comboEnemies2 = baseEnemies.slice();
                        for (var cbi2 = 0; cbi2 < limitBranch.length; cbi2++) {
                            var branch2 = (ci2 >> cbi2) & 1;
                            if (limitBranch[cbi2][branch2]) comboEnemies2.push(limitBranch[cbi2][branch2]);
                        }
                        comboSum2 += survive(nr, nc, newCoily, comboEnemies2, depth - 1);
                    }
                    prob *= comboSum2 / nCombo2;
                }
            }
            if (prob > bestProb) bestProb = prob;
        }
        if (mKey) { memo.set(mKey, bestProb); _persistMemoCount++; }
        return bestProb;
    }

    // Top-level: P(survive DEPTH hops | direction dir)
    // Uses prevR/prevC for ROM-accurate Coily chase on the first hop only.
    // Recursive levels default to pR/pC which equals prev at those levels.
    function dirSurvivalProb(pR, pC, coily, enemies, depth, dir) {
        var d = DIRS[dir];
        var nr = pR + d.dr, nc = pC + d.dc;
        if (!isValidPos(nr, nc)) {
            for (var dci = 0; dci < gs.discs.length; dci++) {
                var disc = gs.discs[dci];
                if (!disc.active) continue;
                if ((disc.side === 0 && dir === 'UL' && pC === 0 && pR === disc.row) ||
                    (disc.side === 1 && dir === 'UR' && pC === pR && pR === disc.row)) {
                    // Verify no enemy is already on player's tile (simStep checks
                    // collision before the move — disc doesn't help if already dead)
                    for (var dcei = 0; dcei < enemies.length; dcei++) {
                        var dce = enemies[dcei];
                        if (dce.spawnAnimTimer > 0) continue;
                        if (!dce.jumping && dce.row === pR && dce.col === pC) return 0;
                        if (dce.jumping && dce.jumpT >= 0.67 && dce.destRow === pR && dce.destCol === pC) return 0;
                    }
                    if (coily && coily.row >= 0) {
                        var ctr = coily.jumping ? ((coily.jumpT||0) < 0.33 ? coily.row : ((coily.jumpT||0) >= 0.67 ? coily.destRow : -99)) : coily.row;
                        var ctc = coily.jumping ? ((coily.jumpT||0) < 0.33 ? coily.col : ((coily.jumpT||0) >= 0.67 ? coily.destCol : -99)) : coily.col;
                        if (ctr === pR && ctc === pC) return 0;
                        // Simulate Coily during disc ride: 30 frames with lure,
                        // then check if Coily is at apex (0,0) when player lands
                        var lureR = disc.row;
                        var lureC = disc.side === 0 ? -1 : disc.row + 1;
                        var dcr = coily.row, dcc = coily.col;
                        var dcj = coily.jumping, dct = coily.jumpT || 0;
                        var dcm = coily.moveTimer || 0;
                        var dcdr = coily.destRow, dcdc = coily.destCol;
                        for (var df = 0; df < 30; df++) {
                            if (dcj) {
                                dct += cJumpDur;
                                if (dct >= 1) {
                                    dcj = false; dct = 0; dcm = 0; dcr = dcdr; dcc = dcdc; dcdr = null; dcdc = null;
                                    if (!isValidPos(dcr, dcc)) break; // Coily fell off — safe
                                }
                            } else {
                                dcm++;
                                if (dcm >= cIdleFrames) {
                                    var dcn = coilyChaseStep(dcr, dcc, lureR, lureC);
                                    if (dcn) { dcj = true; dct = 0; dcm = 0; dcdr = dcn.row; dcdc = dcn.col; }
                                    else { dcj = true; dct = 0; dcm = 0; dcdr = lureR; dcdc = lureC; }
                                }
                            }
                        }
                        // Check collision at (0,0): Coily collision tile after 30 frames
                        var dcTileR, dcTileC;
                        if (dcj) {
                            if (dct < 0.33) { dcTileR = dcr; dcTileC = dcc; }
                            else if (dct >= 0.67 && dcdr != null) { dcTileR = dcdr; dcTileC = dcdc; }
                            else { dcTileR = -99; dcTileC = -99; }
                        } else { dcTileR = dcr; dcTileC = dcc; }
                        if (dcTileR === 0 && dcTileC === 0) return 0;
                    }
                    return 1.0;
                }
            }
            return 0;
        }
        // Pre-move Coily collision: simStep runs simCheckCollision before simTryMove.
        // If Coily's collision tile is already on the player, it's instant death.
        if (coily && coily.row >= 0) {
            var coilyTileR, coilyTileC;
            if (coily.jumping) {
                if ((coily.jumpT || 0) < 0.33) { coilyTileR = coily.row; coilyTileC = coily.col; }
                else if ((coily.jumpT || 0) >= 0.67 && coily.destRow != null) { coilyTileR = coily.destRow; coilyTileC = coily.destCol; }
                else { coilyTileR = -99; coilyTileC = -99; } // mid-air, immune
            } else { coilyTileR = coily.row; coilyTileC = coily.col; }
            if (coilyTileR === pR && coilyTileC === pC) return 0;
            // ROM guard: simTryMove sets prevRow=row BEFORE the hop starts
            var correctCoily = simCoilyHop(pR, pC, nr, nc, coily, pR, pC);
            if (!correctCoily) return 0; // Coily collision during hop
        }
        // Delegate to survive — at recursive levels, prev defaults to pR which is
        // correct (prev = position before the hop in the recursive chain).
        return survive(pR, pC, coily, enemies, depth, dir);
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
        _dirDeadline = typeof performance !== 'undefined' ? performance.now() + 20 : Infinity;

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

        // Iterative deepening: start shallow, go deeper if time permits.
        // Each completed depth gives a valid answer; timeout keeps the last one.
        var survProb = 1.0;
        var maxDepth = (dir === 'STAY') ? Math.min(DEPTH, 3) : DEPTH;
        if (hasEnemies && maxDepth > 0 && !isLevelComplete) {
            var ci0 = coilyInit || { row:-99, col:-99, jumping:false, jumpT:0,
                moveTimer:0, destRow:null, destCol:null };
            for (var idDepth = 2; idDepth <= maxDepth; idDepth += 2) {
                // Depth 2 always runs (safety-critical); deeper levels respect per-direction deadline
                if (idDepth > 2 && typeof performance !== 'undefined' && performance.now() > _dirDeadline) break;
                survProb = dirSurvivalProb(gs.player.row, gs.player.col, ci0, enemyInits, idDepth, dir);
                if (survProb <= 0) break; // already dead, no need to go deeper
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
            // simStep died — override tree's survival probability
            // (catches disc ride deaths where tree only simulates Coily, not all enemies)
            survProb = 0; hop1Surv[dir] = 0;
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

    // Validate: if tree says safe, verify with simStep. RNG saved/restored carefully.
    if (bestDir && bestDir !== 'STAY' && hop1Surv[bestDir] >= 0.9) {
        var _valRng = simRng; // save GAME rng
        var valDeaths = 0;
        var valDeathInfo = '';
        for (var vs = 0; vs < 5; vs++) {
            simRng = createSeededRng(baseSeed + vs * 131 + 7);
            var vc = simDeepClone(gs);
            if (!simStep(vc, bestDir)) {
                valDeaths++;
                if (!valDeathInfo) valDeathInfo = ' killed_by=' + (vc.deathEnemy||'?') +
                    ' player=(' + vc.player.row + ',' + vc.player.col + ')' +
                    (vc.player.jumping ? 'j' + (vc.player.jumpT||0).toFixed(2) : '') +
                    ' freeze=' + (vc.freezeTimer||0);
            }
        }
        // Death trap check: if hop 1 survives, check if ALL directions from
        // landing position are fatal. The tree should have detected this.
        if (valDeaths === 0) {
            simRng = createSeededRng(baseSeed + 999);
            var dtc = simDeepClone(gs);
            simStep(dtc, bestDir);
            if (dtc.alive && !dtc.levelWon) {
                var anyHop2Survive = false;
                for (var dt2 = 0; dt2 < DIR_KEYS_WITH_STAY.length; dt2++) {
                    var dt2d = DIR_KEYS_WITH_STAY[dt2];
                    if (!simCanMove(dtc, dt2d)) continue;
                    var dtc2 = simDeepClone(dtc);
                    simRng = createSeededRng(baseSeed + dt2 * 77 + 333);
                    if (simStep(dtc2, dt2d)) { anyHop2Survive = true; break; }
                }
                if (!anyHop2Survive) {
                    console.log('DEATH TRAP: ' + bestDir + ' P=' + hop1Surv[bestDir].toFixed(3) +
                        ' from (' + gs.player.row + ',' + gs.player.col + ')→(' +
                        dtc.player.row + ',' + dtc.player.col + ')');
                    // Override: tree says safe but destination is a death trap
                    hop1Surv[bestDir] = 0;
                    aiMoveScores[bestDir] = -10000;
                    bestDir = null; bestScore = -Infinity;
                    for (var dtk = 0; dtk < DIR_KEYS_WITH_STAY.length; dtk++) {
                        var dtd = DIR_KEYS_WITH_STAY[dtk];
                        if (aiMoveScores[dtd] === undefined) continue;
                        if (aiMoveScores[dtd] > bestScore) { bestScore = aiMoveScores[dtd]; bestDir = dtd; }
                    }
                }
            }
        }
        simRng = _valRng; // restore GAME rng (critical!)
        if (valDeaths > 0) {
            var _bd = DIRS[bestDir];
            var _bnr = gs.player.row + _bd.dr, _bnc = gs.player.col + _bd.dc;
            var diagParts = [];
            for (var _di = 0; _di < enemyInits.length; _di++) {
                var _de = enemyInits[_di];
                var _dr = simOneEnemy(gs.player.row, gs.player.col, _bnr, _bnc, _de);
                var _safes = [];
                for (var _dbi = 0; _dbi < _dr.branches.length; _dbi++) _safes.push(_dr.branches[_dbi].safe);
                diagParts.push(_de.type + '@(' + _de.row + ',' + _de.col + ')' +
                    (_de.jumping ? 'j' + (_de.jumpT||0).toFixed(2) + '→' + _de.destRow + ',' + _de.destCol : 't' + _de.moveTimer) +
                    ' branches=' + _dr.count + ' safe=[' + _safes.join(',') + ']');
            }
            console.log('TREE BUG: ' + bestDir + ' P=' + hop1Surv[bestDir].toFixed(3) +
                ' but simStep died ' + valDeaths + '/5' + valDeathInfo + ' from (' + gs.player.row + ',' + gs.player.col +
                ') enemies: ' + gs.enemies.filter(function(e){ return e.type !== 'spawn-timer'; }).map(function(e){
                    return e.type + '@(' + e.row + ',' + e.col + ')' +
                        (e.jumping ? 'j' + (e.jumpT||0).toFixed(2) + '→' + e.destRow + ',' + e.destCol : 't' + (e.moveTimer||0)) +
                        (e.spawnAnimTimer > 0 ? 'sa' + e.spawnAnimTimer : '');
                }).join(' ') +
                ' | tree: ' + diagParts.join('; '));
        }
    }

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
    return result;
}
