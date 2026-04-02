// qbert-ai.js — Q*bert AI logic  (v2 — oscillation fix + revert penalty)
var AI_VERSION = 'v6.3-fixOverrides';
// Requires: qbert.js loaded first (provides constants, board, simulation)
//
// Provides: aiPickBestDir() — main entry point for AI move selection
//
// Unified AI: always tour-plan, validate safety via simulation.
// No mode switching — Coily just means more safety samples.
//
// The AI uses the SAME simulation code as the game (simStep from qbert.js).
// No separate collision model — what the AI predicts IS what the game does.

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
    // On L5+ (full cycle), traversing a completed cube costs 3 extra hops to fix (2→0, then 0→1→2)
    // On L3-4 (toggle/partial revert), cost is lower
    var REVERT_PENALTY = isToggle ? 2 : 0;
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
                    // L5+: prefer bottom-row cubes to avoid backtracking through completed upper cubes
                    if (lv >= 5) d -= idxToPos[i][0];
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

// Pre-compute enemy positions frame-by-frame using actual game code.
// Removes Coily (handled per-path) and player (independent).
// Returns array of threat sets per frame: threats[frame] = {"row,col": true}
// Pre-compute all POSSIBLE enemy positions for N frames ahead.
// Enumerates all random decisions (spawn column, DL/DR, up/stay) as branches.
// Each enemy tracked as a set of possible states; positions merge at each frame.
function precomputeFrameTimeline(gs, maxFrames) {
    // Build per-enemy state sets: each enemy → array of possible states
    var enemySets = []; // [{type, states: [{row, col, jumping, jumpT, moveTimer, hops, dirBits, ...}]}]
    var spawnTimers = [];

    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type === 'coily') continue;
        if (e.type === 'slick' || e.type === 'greenball') continue;
        if (e.type === 'spawn-timer') {
            spawnTimers.push({ timer: e.timer, forcedType: e.forcedType });
            continue;
        }
        enemySets.push({
            states: [{
                type: e.type, row: e.row, col: e.col,
                jumping: !!e.jumping, jumpT: e.jumpT || 0,
                jumpDur: e.jumpDur || ENEMY_JUMP_DUR * gs.sm,
                jumpSrcRow: e.jumpSrcRow, jumpSrcCol: e.jumpSrcCol,
                destRow: e.destRow, destCol: e.destCol,
                moveTimer: e.moveTimer || 0,
                moveInterval: e.moveInterval || enemyMoveInterval(e.type, gs.sm),
                hops: e.hops || 0, dirBits: e.dirBits,
                spawnAnimTimer: e.spawnAnimTimer || 0,
                falling: false
            }]
        });
    }

    var timeline = [];
    for (var f = 0; f <= maxFrames; f++) {
        // Handle spawn timers FIRST (matches simUpdateEnemies order)
        for (var ti = spawnTimers.length - 1; ti >= 0; ti--) {
            spawnTimers[ti].timer--;
            if (spawnTimers[ti].timer <= 0) {
                var ft = spawnTimers[ti].forcedType || 'redball';
                var sInterval = enemyMoveInterval(ft, gs.sm);
                var sStates = [];
                if (ft === 'ugg') {
                    sStates.push({ type:'ugg', row:ROWS-1, col:ROWS-1, jumping:false, jumpT:0,
                        jumpDur:ENEMY_JUMP_DUR*gs.sm, moveTimer:0, moveInterval:sInterval,
                        hops:0, dirBits:undefined, spawnAnimTimer:20, falling:false });
                } else if (ft === 'wrongway') {
                    sStates.push({ type:'wrongway', row:ROWS-1, col:0, jumping:false, jumpT:0,
                        jumpDur:ENEMY_JUMP_DUR*gs.sm, moveTimer:0, moveInterval:sInterval,
                        hops:0, dirBits:undefined, spawnAnimTimer:20, falling:false });
                } else {
                    for (var sc = 0; sc < 2; sc++) {
                        sStates.push({ type:ft, row:1, col:sc, jumping:false, jumpT:0,
                            jumpDur:ENEMY_JUMP_DUR*gs.sm, moveTimer:0, moveInterval:sInterval,
                            hops:0, dirBits:undefined, spawnAnimTimer:20, falling:false });
                    }
                }
                enemySets.push({ states: sStates });
                spawnTimers.splice(ti, 1);
            }
        }
        // Build threat set from all possible positions
        var threats = {};
        for (var ei = 0; ei < enemySets.length; ei++) {
            for (var si = 0; si < enemySets[ei].states.length; si++) {
                var s = enemySets[ei].states[si];
                if ((s.falling && !s.jumping) || s.spawnAnimTimer > 0) continue;
                // Collision tile based on jump phase
                if (!s.jumping) {
                    threats[s.row + ',' + s.col] = true;
                } else if (s.jumpT < 0.33) {
                    threats[s.row + ',' + s.col] = true;
                } else if (s.jumpT >= 0.67 && s.destRow != null) {
                    threats[s.destRow + ',' + s.destCol] = true;
                }
                // else: immune at apex, no threat
            }
        }
        timeline.push(threats);

        // Advance each enemy's possible states by 1 frame
        for (var ei2 = 0; ei2 < enemySets.length; ei2++) {
            var next = [];
            var seen = {};
            for (var si2 = 0; si2 < enemySets[ei2].states.length; si2++) {
                var st = enemySets[ei2].states[si2];
                if (st.falling && !st.jumping) continue; // remove after landing off-grid
                if (st.spawnAnimTimer > 0) { st.spawnAnimTimer--; next.push(st); continue; }

                if (st.jumping) {
                    st.jumpT += st.jumpDur;
                    if (st.jumpT >= 1) {
                        st.jumping = false; st.jumpT = 0; st.moveTimer = 0;
                        st.row = st.destRow; st.col = st.destCol;
                        st.destRow = null; st.destCol = null;
                        if (!isValidPos(st.row, st.col)) { st.falling = true; continue; }
                        if (st.type === 'egg' && (st.hops >= 6 || st.row >= ROWS - 1)) {
                            st.falling = true; continue; // egg hatches → becomes Coily (handled separately)
                        }
                    }
                    var key = st.row + ',' + st.col + ',' + Math.round(st.jumpT * 10);
                    if (!seen[key]) { seen[key] = true; next.push(st); }
                } else {
                    st.moveTimer++;
                    if (st.moveTimer >= st.moveInterval) {
                        // Start hop — enumerate possible destinations
                        var dests = [];
                        if (st.type === 'egg' || st.type === 'redball') {
                            if (st.dirBits != null) {
                                // Deterministic: one destination
                                var nr = st.row + 1, nc = (st.dirBits & 1) ? st.col + 1 : st.col;
                                dests.push({ r: nr, c: nc, dirBits: st.dirBits >> 1 });
                            } else {
                                // Random: both DL and DR
                                dests.push({ r: st.row + 1, c: st.col, dirBits: undefined });
                                dests.push({ r: st.row + 1, c: st.col + 1, dirBits: undefined });
                            }
                        } else if (st.type === 'ugg') {
                            dests.push({ r: st.row - 1, c: st.col - 1 });
                            dests.push({ r: st.row, c: st.col - 1 });
                        } else if (st.type === 'wrongway') {
                            dests.push({ r: st.row - 1, c: st.col });
                            dests.push({ r: st.row, c: st.col + 1 });
                        }
                        for (var di = 0; di < dests.length; di++) {
                            var d = dests[di];
                            // Even if destination is invalid (falling off), keep the enemy
                            // during its jump for collision at the source position
                            var ns = {
                                type: st.type, row: st.row, col: st.col,
                                jumping: true, jumpT: 0, jumpDur: st.jumpDur,
                                destRow: d.r, destCol: d.c,
                                moveTimer: 0, moveInterval: st.moveInterval,
                                hops: st.hops + 1, dirBits: d.dirBits !== undefined ? d.dirBits : st.dirBits,
                                spawnAnimTimer: 0, falling: !isValidPos(d.r, d.c)
                            };
                            var nk = ns.row + ',' + ns.col + '→' + d.r + ',' + d.c;
                            if (!seen[nk]) { seen[nk] = true; next.push(ns); }
                        }
                    } else {
                        var ik = st.row + ',' + st.col + ',idle';
                        if (!seen[ik]) { seen[ik] = true; next.push(st); }
                    }
                }
            }
            enemySets[ei2].states = next;
        }

        // (spawn timers handled at top of loop)
    }
    return timeline;
}

// DFS: can the player survive for `maxHops` hops?
// Uses pre-computed enemy timeline + deterministic Coily simulation.
// Player hop = ~35 frames. Checks collision at each frame against timeline.
// Frame-perfect survival check with memoization.
// Simulates player + Coily frame-by-frame with correct timing.
// At hop boundaries, paths with same (player, coily, hop) merge.
function dfsSurvive(pR, pC, prevR, prevC, coily, frameThreat, startFrame, maxHops, sm) {
    var pJumpDur = PLAYER_JUMP_DUR * sm;
    var pJumpFrames = Math.ceil(1 / pJumpDur);
    var cJumpDur = ENEMY_JUMP_DUR * sm;
    var cIdleFrames = enemyMoveInterval('coily', sm);
    var memo = {};

    function search(pR, pC, cR, cC, cJumping, cJumpT, cTimer,
                    cDestR, cDestC, cPrevR, cPrevC, frame, hop) {
        if (hop >= maxHops) return true;

        var key = pR * 1000000 + pC * 100000 + cR * 10000 + cC * 1000 + hop * 100 +
                  (cJumping ? 50 : 0) + Math.round((cJumpT || 0) * 10);
        if (memo[key] !== undefined) return memo[key];

        var result = false;
        for (var dk = 0; dk < DIR_KEYS.length && !result; dk++) {
            var dd = DIRS[DIR_KEYS[dk]];
            var nr = pR + dd.dr, nc = pC + dd.dc;
            if (!isValidPos(nr, nc)) continue;

            // Simulate this player hop frame by frame
            var alive = true;
            var cr = cR, cc = cC, cj = cJumping, ct = cJumpT, cm = cTimer;
            var cdr = cDestR, cdc = cDestC, cpr = cPrevR, cpc = cPrevC;

            for (var f = 1; f <= pJumpFrames && alive; f++) {
                var playerT = f * pJumpDur;
                var fi = Math.min(frame + f, frameThreat.length - 1);

                // Advance Coily 1 frame
                if (cj) {
                    ct += cJumpDur;
                    if (ct >= 1) {
                        cj = false; ct = 0; cm = 0;
                        cr = cdr; cc = cdc; cdr = null; cdc = null;
                    }
                } else {
                    cm++;
                    if (cm >= cIdleFrames) {
                        var tR = cpr, tC = cpc;
                        if (cr === tR && cc === tC) { tR = pR; tC = pC; }
                        var cn = coilyChaseStep(cr, cc, tR, tC);
                        if (cn) {
                            cj = true; ct = 0; cm = 0;
                            cdr = cn.row; cdc = cn.col;
                            cpr = cr; cpc = cc;
                        }
                    }
                }

                // Player collision tile
                var ptR, ptC;
                if (playerT < 0.33) { ptR = pR; ptC = pC; }
                else if (playerT >= 0.67) { ptR = nr; ptC = nc; }
                else continue; // immune

                // Coily collision tile
                var ctR, ctC;
                if (cj) {
                    if (ct < 0.33) { ctR = cr; ctC = cc; }
                    else if (ct >= 0.67 && cdr != null) { ctR = cdr; ctC = cdc; }
                    else { ctR = -99; ctC = -99; }
                } else {
                    ctR = cr; ctC = cc;
                }

                if (frameThreat[fi] && frameThreat[fi][ptR + ',' + ptC]) alive = false;
                if (ptR === ctR && ptC === ctC) alive = false;
            }

            if (alive) {
                result = search(nr, nc, cr, cc, cj, ct, cm,
                               cdr, cdc, cpr, cpc, frame + pJumpFrames, hop + 1);
            }
        }

        memo[key] = result;
        return result;
    }

    return search(pR, pC, coily.row, coily.col,
                  coily.jumping || false, coily.jumpT || 0, coily.moveTimer || 0,
                  coily.destRow || null, coily.destCol || null,
                  coily.prevR, coily.prevC, startFrame, 0);
}

// Pre-compute non-Coily enemy POSSIBLE positions for N hops ahead.
// For deterministic enemies (red ball/dirBits): exactly 1 position per hop.
// For random enemies (egg, ugg, wrongway): enumerate ALL possible positions.
// Returns threatSets[hop] = set of "row,col" strings (union of all possibilities).
function precomputeEnemyTimeline(gs, maxHops) {
    // Each enemy tracked as a set of possible {row, col, state} tuples
    var enemySets = [];
    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];
        if (e.type === 'coily' || e.type === 'spawn-timer') continue;
        if (e.type === 'slick' || e.type === 'greenball') continue; // harmless
        if (e.spawnAnimTimer > 0) continue;
        var positions = [{ row: e.row, col: e.col, type: e.type, hops: e.hops || 0,
                           dirBits: e.dirBits }];
        enemySets.push(positions);
    }

    var sets = [];
    for (var hop = 0; hop <= maxHops; hop++) {
        // Build threat set: union of all possible positions of all enemies
        var s = {};
        for (var ei = 0; ei < enemySets.length; ei++) {
            for (var pi = 0; pi < enemySets[ei].length; pi++) {
                var p = enemySets[ei][pi];
                s[p.row + ',' + p.col] = true;
            }
        }
        sets.push(s);

        // Advance each enemy — expand possible positions
        for (var ei2 = 0; ei2 < enemySets.length; ei2++) {
            var nextPositions = [];
            var seen = {};
            for (var pi2 = 0; pi2 < enemySets[ei2].length; pi2++) {
                var pos = enemySets[ei2][pi2];
                var moves = [];
                if (pos.type === 'egg') {
                    moves.push({ row: pos.row + 1, col: pos.col });     // DL
                    moves.push({ row: pos.row + 1, col: pos.col + 1 }); // DR
                } else if (pos.type === 'redball') {
                    if (pos.dirBits != null) {
                        var nr = pos.row + 1, nc = (pos.dirBits & 1) ? pos.col + 1 : pos.col;
                        moves.push({ row: nr, col: nc });
                    } else {
                        moves.push({ row: pos.row + 1, col: pos.col });
                        moves.push({ row: pos.row + 1, col: pos.col + 1 });
                    }
                } else if (pos.type === 'ugg') {
                    moves.push({ row: pos.row - 1, col: pos.col - 1 });
                    moves.push({ row: pos.row, col: pos.col - 1 });
                } else if (pos.type === 'wrongway') {
                    moves.push({ row: pos.row - 1, col: pos.col });
                    moves.push({ row: pos.row, col: pos.col + 1 });
                }
                for (var mi = 0; mi < moves.length; mi++) {
                    var m = moves[mi];
                    if (!isValidPos(m.row, m.col)) continue;
                    var key = m.row + ',' + m.col;
                    if (seen[key]) continue;
                    seen[key] = true;
                    nextPositions.push({
                        row: m.row, col: m.col, type: pos.type,
                        hops: pos.hops + 1,
                        dirBits: pos.dirBits != null ? (pos.dirBits >> 1) : undefined
                    });
                }
            }
            if (nextPositions.length > 0) enemySets[ei2] = nextPositions;
        }
    }
    return sets;
}

// DFS: can the player survive for `depth` hops?
// Pre-computed enemyThreat[hop] = set of non-Coily threat positions.
// Coily simulated per-path (deterministic given player moves).
// Returns true if ANY player path survives.
function canSurviveDeep(pR, pC, prevR, prevC, cR, cC, cPrevR, cPrevC,
                         enemyThreat, hop, maxHop) {
    if (hop >= maxHop) return true; // survived!

    // Coily chase step (deterministic)
    var cTargetR = cPrevR, cTargetC = cPrevC;
    if (cR === cTargetR && cC === cTargetC) { cTargetR = pR; cTargetC = pC; }
    var cNext = coilyChaseStep(cR, cC, cTargetR, cTargetC);
    var cNR = cNext ? cNext.row : -99, cNC = cNext ? cNext.col : -99;

    var threats = enemyThreat[Math.min(hop, enemyThreat.length - 1)];

    // Try each player move
    for (var dk = 0; dk < DIR_KEYS.length; dk++) {
        var dd = DIRS[DIR_KEYS[dk]];
        var npR = pR + dd.dr, npC = pC + dd.dc;
        if (!isValidPos(npR, npC)) continue;

        // Collision with Coily
        if (npR === cNR && npC === cNC) continue;
        // Cross-path with Coily
        if (npR === cR && npC === cC && pR === cNR && pC === cNC) continue;
        // Collision with non-Coily enemies
        if (threats[npR + ',' + npC]) continue;

        if (canSurviveDeep(npR, npC, pR, pC, cNR, cNC, cR, cC,
                           enemyThreat, hop + 1, maxHop)) {
            return true;
        }
    }
    return false;
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

function predictCoilyNext(coilyR, coilyC, targetR, targetC) {
    var bestDir = null, bestDist = Infinity;
    for (var k = 0; k < 4; k++) {
        var dk = DIRS[DIR_KEYS[k]];
        var nr = coilyR + dk.dr, nc = coilyC + dk.dc;
        if (!isValidPos(nr, nc)) continue;
        var dist = Math.abs(targetR - nr) + Math.abs(targetC - nc);
        if (dist < bestDist) { bestDist = dist; bestDir = k; }
    }
    if (bestDir === null) return { row: coilyR, col: coilyC };
    var dd = DIRS[DIR_KEYS[bestDir]];
    return { row: coilyR + dd.dr, col: coilyC + dd.dc };
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

// ─── Exhaustive nearby-enemy safety check ───────────────────────────────────
// For enemies within a few tiles of the player's destination, enumerate ALL
// possible movement paths instead of relying on MC sampling.  This catches
// collisions that 20 random seeds can miss (e.g. ugg/wrongway approaching
// from the side with a 12% collision probability → 8% MC miss rate).
//
// Approach: for each nearby non-deterministic enemy, recursively try both
// direction choices at every hop and check frame-level collision with the
// player.  With at most 2 hops per enemy per player jump, this is 2^2 = 4
// paths per enemy — trivially fast.

var EXHAUSTIVE_RADIUS = 5; // Manhattan-distance threshold for "nearby"

// Precompute the player's collision tile at each frame during a jump.
// Returns an array where index = frame number, value = {row,col} or null (immune).
// Returns null for disc moves (player goes off-grid).
function computePlayerTiles(pRow, pCol, dir, sm) {
    if (dir === 'STAY') {
        var maxWait = Math.ceil(1.0 / (PLAYER_JUMP_DUR * sm)) + 10;
        var tiles = [];
        for (var f = 0; f < maxWait; f++) tiles.push({ row: pRow, col: pCol });
        return tiles;
    }
    var d = DIRS[dir];
    var destR = pRow + d.dr, destC = pCol + d.dc;
    if (!isValidPos(destR, destC)) return null; // disc move — skip
    var jumpDur = PLAYER_JUMP_DUR * sm;
    var tiles = [];
    var jumpT = 0;
    var landed = false;
    for (var f = 0; f < 60; f++) {
        if (!landed) {
            jumpT += jumpDur;
            if (jumpT >= 1) {
                landed = true;
                tiles.push({ row: destR, col: destC });
                continue;
            }
            if (jumpT < 0.33) tiles.push({ row: pRow, col: pCol });
            else if (jumpT >= 0.67) tiles.push({ row: destR, col: destC });
            else tiles.push(null);
        } else {
            // One idle frame after landing (matches simStep post-landing check)
            tiles.push({ row: destR, col: destC });
            break;
        }
    }
    return tiles;
}

// Lightweight clone of a single enemy for the exhaustive search tree
function cloneEnemyLight(e) {
    return {
        type: e.type, row: e.row, col: e.col,
        jumping: e.jumping, jumpT: e.jumpT, jumpDur: e.jumpDur,
        destRow: e.destRow, destCol: e.destCol,
        jumpSrcRow: e.jumpSrcRow, jumpSrcCol: e.jumpSrcCol,
        moveTimer: e.moveTimer, moveInterval: e.moveInterval,
        hops: e.hops || 0, falling: e.falling || false,
        willHatch: e.willHatch || false,
        spawnAnimTimer: e.spawnAnimTimer || 0
    };
}

// All possible move destinations for an enemy at a hop decision point.
// Coily is deterministic (chases player), so returns exactly 1 choice.
// Random enemies (ugg, wrongway, redball, egg) return 2 choices.
function getEnemyMoveChoices(e, playerDestR, playerDestC) {
    if (e.type === 'coily') {
        var bestDist = Infinity, bestR = e.row, bestC = e.col;
        for (var k = 0; k < 4; k++) {
            var dk = DIRS[DIR_KEYS[k]];
            var tr = e.row + dk.dr, tc = e.col + dk.dc;
            if (!isValidPos(tr, tc)) continue;
            var dist = Math.abs(playerDestR - tr) + Math.abs(playerDestC - tc);
            if (dist < bestDist) { bestDist = dist; bestR = tr; bestC = tc; }
        }
        return [{ nr: bestR, nc: bestC }];
    }
    if (e.type === 'egg' || e.type === 'redball') {
        return [{ nr: e.row + 1, nc: e.col }, { nr: e.row + 1, nc: e.col + 1 }];
    }
    if (e.type === 'ugg') {
        return [{ nr: e.row - 1, nc: e.col - 1 }, { nr: e.row, nc: e.col - 1 }];
    }
    if (e.type === 'wrongway') {
        return [{ nr: e.row - 1, nc: e.col }, { nr: e.row, nc: e.col + 1 }];
    }
    return [];
}

// Get the collision tile for an enemy (mirrors collisionTile in qbert.js)
function enemyCollisionTile(e) {
    if (!e.jumping) return { row: e.row, col: e.col };
    if (e.jumpT < 0.33) return { row: e.row, col: e.col };
    if (e.jumpT >= 0.67) return { row: e.destRow, col: e.destCol };
    return null; // immune at apex
}

// Recursive search: can this single enemy collide with the player on ANY
// possible path?  Branches at each move-decision point (2 choices per hop).
// Returns true if any branch produces a collision.
function enemyPathCollides(e, playerTiles, frame, maxFrames, pDestR, pDestC, sm) {
    if (frame >= maxFrames || e.falling) return false;

    // ── Advance enemy by one frame ──
    if (e.jumping) {
        e.jumpT += e.jumpDur;
        if (e.jumpT >= 1) {
            e.jumping = false;
            e.row = e.destRow; e.col = e.destCol;
            if (!isValidPos(e.row, e.col)) return false; // fell off
            if (e.type === 'egg' && ((e.hops || 0) >= 6 || e.row >= ROWS - 1)) {
                e.type = 'coily';
                e.moveInterval = enemyMoveInterval('coily', sm);
            }
        }
        // Collision check
        var et = enemyCollisionTile(e);
        var pt = playerTiles[frame];
        if (et && pt && et.row === pt.row && et.col === pt.col) return true;
        return enemyPathCollides(e, playerTiles, frame + 1, maxFrames, pDestR, pDestC, sm);
    }

    // ── Idle: tick move timer ──
    e.moveTimer++;
    if (e.moveTimer < e.moveInterval) {
        // Not moving yet — check collision at current position
        var pt2 = playerTiles[frame];
        if (pt2 && pt2.row === e.row && pt2.col === e.col) return true;
        return enemyPathCollides(e, playerTiles, frame + 1, maxFrames, pDestR, pDestC, sm);
    }

    // ── Move decision — BRANCH POINT ──
    e.moveTimer = 0;
    var choices = getEnemyMoveChoices(e, pDestR, pDestC);
    for (var ci = 0; ci < choices.length; ci++) {
        var ec = cloneEnemyLight(e);
        ec.jumping = true;
        ec.jumpT = 0;
        ec.destRow = choices[ci].nr;
        ec.destCol = choices[ci].nc;
        ec.hops++;
        if (!isValidPos(choices[ci].nr, choices[ci].nc)) ec.falling = true;
        // Check collision right after starting jump (jumpT=0 < 0.33 → source tile)
        var pt3 = playerTiles[frame];
        if (pt3 && pt3.row === ec.row && pt3.col === ec.col) return true;
        if (enemyPathCollides(ec, playerTiles, frame + 1, maxFrames, pDestR, pDestC, sm)) {
            return true;
        }
    }
    return false;
}

// Main entry: returns true if direction is safe from ALL possible nearby-enemy paths.
function isExhaustiveSafe(gs, dir) {
    var playerTiles = computePlayerTiles(gs.player.row, gs.player.col, dir, gs.sm);
    if (!playerTiles) return true; // disc move — no on-grid collision possible

    var d = DIRS[dir];
    var destR = dir === 'STAY' ? gs.player.row : gs.player.row + d.dr;
    var destC = dir === 'STAY' ? gs.player.col : gs.player.col + d.dc;
    var maxFrames = playerTiles.length;
    var startFrame = Math.min(gs.freezeTimer || 0, maxFrames);

    for (var i = 0; i < gs.enemies.length; i++) {
        var e = gs.enemies[i];

        // Check spawn-timers that will expire during this hop — enemy spawns mid-jump
        if (e.type === 'spawn-timer') {
            if (e.timer <= maxFrames) {
                var ft = e.forcedType;
                if (!ft) {
                    var hasCoilyOrEgg = false;
                    for (var ci = 0; ci < gs.enemies.length; ci++)
                        if (gs.enemies[ci].type === 'coily' || gs.enemies[ci].type === 'egg') { hasCoilyOrEgg = true; break; }
                    ft = hasCoilyOrEgg ? 'redball' : 'egg';
                }
                // Redballs and eggs spawn at row 1, col 0 or 1 — check both
                if (ft === 'redball' || ft === 'egg') {
                    for (var sc = 0; sc < 2; sc++) {
                        for (var f = e.timer; f < maxFrames; f++) {
                            var pt = playerTiles[f];
                            if (pt && pt.row === 1 && pt.col === sc) return false;
                        }
                    }
                }
            }
            continue;
        }

        // Skip non-threatening types and Coily (deterministic — MC handles perfectly)
        if (e.type === 'slick' || e.type === 'greenball') continue;
        if (e.type === 'coily') continue;

        // Effective position for distance check
        var er = e.jumping && e.jumpT >= 0.67 ? (e.destRow != null ? e.destRow : e.row) : e.row;
        var ec2 = e.jumping && e.jumpT >= 0.67 ? (e.destCol != null ? e.destCol : e.col) : e.col;
        var distDest = Math.abs(er - destR) + Math.abs(ec2 - destC);
        var distSrc = Math.abs(er - gs.player.row) + Math.abs(ec2 - gs.player.col);
        if (distDest > EXHAUSTIVE_RADIUS && distSrc > EXHAUSTIVE_RADIUS) continue;

        var eClone = cloneEnemyLight(e);
        if (enemyPathCollides(eClone, playerTiles, startFrame, maxFrames, destR, destC, gs.sm)) {
            return false;
        }
    }
    return true;
}

// ─── Tour greedy planner ─────────────────────────────────────────────────────
var aiTour = [], aiTourIdx = 0, aiBoardSig = '';
var aiDetailPath = [], aiTourDots = [];

var aiRevertCounts = new Int8Array(POS_COUNT); // per-cube revert counter for toggle levels
var aiPrevCubeStates = null; // previous cube states to detect reverts

function aiTourInit() {
    aiLastRemaining = 99; aiBestRemaining = 99; aiNoProgressCount = 0; aiStayCount = 0; aiSamePosCount = 0; aiPosHistory = [];
    aiRevertCounts = new Int8Array(POS_COUNT);
    aiPrevCubeStates = null;
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

// ─── Disc lure evaluation ────────────────────────────────────────────────────

function coilyLured(coily, disc) {
    var exitRow = disc.row;
    var lureR = exitRow - 1;
    var lureC = disc.side === 0 ? 0 : exitRow;
    var bestDir = null, bestDist = Infinity;
    for (var k = 0; k < DIR_KEYS.length; k++) {
        var dk = DIRS[DIR_KEYS[k]];
        var nr = coily.row + dk.dr, nc = coily.col + dk.dc;
        var dist = Math.abs(exitRow - 1 - nr) + Math.abs(lureC - nc);
        if (dist < bestDist) { bestDist = dist; bestDir = { nr: nr, nc: nc }; }
    }
    return bestDir && !isValidPos(bestDir.nr, bestDir.nc);
}

function isSafeMove(dirKey) {
    var d = DIRS[dirKey];
    var nr = player.row + d.dr, nc = player.col + d.dc;
    if (!isValidPos(nr, nc)) return true;
    for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.type === 'spawn-timer' || e.type === 'slick' || e.type === 'greenball') continue;
        var pos = enemyEffectivePos(e);
        if (e.type === 'coily') {
            // Coily's current position is dangerous
            if (pos.row === nr && pos.col === nc) return false;
            // Coily mid-jump landing tile is dangerous
            if (e.destRow != null && e.destRow === nr && e.destCol === nc) return false;
            // Check where Coily goes next (chases player's current pos)
            var cp = predictCoilyNext(pos.row, pos.col, player.row, player.col);
            if (cp.row === nr && cp.col === nc) return false;
        } else {
            if (pos.row === nr && pos.col === nc) return false;
        }
    }
    return true;
}

function evalDiscLure() {
    var coily = null;
    for (var i = 0; i < enemies.length; i++) {
        if (enemies[i].type === 'coily') {
            var pos = enemyEffectivePos(enemies[i]);
            coily = { row: pos.row, col: pos.col };
            break;
        }
    }
    if (!coily) return null;

    var lv = arcadeLevel();

    for (var di = 0; di < discs.length; di++) {
        var disc = discs[di];
        if (!disc.active) continue;
        var discRow = disc.row;
        var discCol = disc.side === 0 ? 0 : discRow;
        var discDir = disc.side === 0 ? 'UL' : 'UR';

        if (player.row === discRow && player.col === discCol) {
            if (coilyLured(coily, disc)) return discDir;
        }

        var pathToDisc = bfsTo(player.row, player.col, discRow, discCol);
        // Path toward disc for lure — but not too far, safety degrades over distance
        // Level 5+: travel farther to lure Coily — peaceful windows are critical
        var maxLureDist = lv >= 5 ? 6 : (lv >= 3 ? 4 : 3);
        if (pathToDisc && pathToDisc.dist <= maxLureDist) {
            // Verify the whole path is safe from Coily interception
            var simCoilyR = coily.row, simCoilyC = coily.col;
            var pathSafe = true;
            var pr = player.row, pc = player.col;
            for (var s = 0; s < pathToDisc.dist; s++) {
                var dk = DIRS[pathToDisc.path[s]];
                pr += dk.dr; pc += dk.dc;
                // Coily chases player toward disc
                var cp = predictCoilyNext(simCoilyR, simCoilyC, pr, pc);
                // Check if Coily lands on or passes through our position
                if ((cp.row === pr && cp.col === pc) ||
                    (simCoilyR === pr && simCoilyC === pc)) {
                    pathSafe = false; break;
                }
                simCoilyR = cp.row; simCoilyC = cp.col;
            }
            if (pathSafe && coilyLured({ row: simCoilyR, col: simCoilyC }, disc)) {
                if (pathToDisc.path.length > 0 && isSafeMove(pathToDisc.path[0])) {
                    return pathToDisc.path[0];
                }
            }
        }
    }
    return null;
}

// ─── Scoring helpers (removed — safety is now handled by 2-hop MC simulation) ─

// ─── Route-first AI: plan optimal path, validate safety via AND-OR tree ──────
// Philosophy: tour planner decides WHERE to go (optimal routing), AND-OR tree
// validates IF it's safe (can survive DEPTH hops against all enemy combos).

// Persistent memo: surviveOne and survive results are deterministic given state.
// Same (player, coily, enemy, depth) always gives same result. No need to clear
// between AI calls — entries from previous calls are still valid.
// Only clear when speed multiplier changes (timing parameters change).
var _persistMemo = {};
var _persistMemoSm = 0;

function unifiedPick(gs, coilyActive) {
    var _perfStart = typeof performance !== 'undefined' ? performance.now() : 0;
    var savedRng = simRng;
    var baseSeed = (gs.player.row * 7 + gs.player.col) * 10000 + (frameCount || 0);
    function simSeed(sampleIdx) { simRng = createSeededRng(baseSeed + sampleIdx * 9973); }
    function restoreRng() { simRng = savedRng; }

    // Reset prediction timeline for validation harness
    window.aiPredictedTimeline = null;

    var hasEnemies = gs.enemies.length > 0;
    var DEPTH = hasEnemies ? (window.AI_DEPTH || 8) : 0;

    var pJumpDur = PLAYER_JUMP_DUR * gs.sm;
    var pJumpFrames = Math.ceil(1 / pJumpDur);
    var cJumpDur = ENEMY_JUMP_DUR * gs.sm;
    var cIdleFrames = enemyMoveInterval('coily', gs.sm);

    // Cross-timestep memo: persist across AI calls, clear on speed change or overflow
    if (gs.sm !== _persistMemoSm || Object.keys(_persistMemo).length > 50000) {
        _persistMemo = {}; _persistMemoSm = gs.sm;
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
                destRow: e.destRow, destCol: e.destCol };
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

    // Simulate Coily for one hop (deterministic — chases pR,pC)
    function simCoilyHop(pR, pC, nr, nc, coily) {
        var cr = coily.row, cc = coily.col;
        var cj = coily.jumping, ct = coily.jumpT || 0, cm = coily.moveTimer || 0;
        var cdr = coily.destRow, cdc = coily.destCol;
        for (var f = 1; f <= pJumpFrames; f++) {
            var playerT = f * pJumpDur;
            if (cj) {
                ct += cJumpDur;
                if (ct >= 1) { cj = false; ct = 0; cm = 0; cr = cdr; cc = cdc; cdr = null; cdc = null; }
            } else {
                cm++;
                if (cm >= cIdleFrames) {
                    var cn = coilyChaseStep(cr, cc, pR, pC);
                    if (cn) { cj = true; ct = 0; cm = 0; cdr = cn.row; cdc = cn.col; }
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
            if (cj && cdr != null && nr === cr && nc === cc && pR === cdr && pC === cdc) return null;
        }
        return { row: cr, col: cc, jumping: cj, jumpT: ct, moveTimer: cm, destRow: cdr, destCol: cdc };
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
                // Still animating: becomes active after spawnAnimTimer frames, then idle at timer=0
                framesUntilDecision = e.spawnAnimTimer + e.moveInterval;
            } else if (e.jumping) {
                // Mid-jump: lands after some frames, then idle at timer=0
                var framesToLand = Math.ceil((1.0 - e.jumpT) / e.jumpDur);
                framesUntilDecision = framesToLand + e.moveInterval;
            } else {
                // Idle: reaches decision when timer hits interval
                framesUntilDecision = e.moveInterval - e.moveTimer;
            }
            if (framesUntilDecision <= pJumpFrames) {
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
            for (var f = 1; f <= pJumpFrames && safe; f++) {
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
                if (e2.jumping && e2.destRow != null &&
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
                   (coily.moveTimer || 0) + ',' + (coily.destRow != null ? coily.destRow : 9) + ',' +
                   (coily.destCol != null ? coily.destCol : 9) + '|' +
                   me.type[0] + me.row + ',' + me.col + ',' + (me.jumping ? 1 : 0) + ',' +
                   Math.round((me.jumpT || 0) * 30) + ',' + me.moveTimer + ',' +
                   (me.destRow != null ? me.destRow : 9) + ',' + (me.destCol != null ? me.destCol : 9) + ',' +
                   (me.hops || 0) + ',' + (me.dirBits != null ? me.dirBits : 'n') + ',' +
                   (me.spawnAnimTimer || 0) + '|' + depth;
        if (memo[mKey] !== undefined) return memo[mKey];

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
        memo[mKey] = bestProb;
        return bestProb;
    }

    // Joint survival: for each direction, compute per-enemy product, take max.
    // max_D [∏_i P_i(D)] — NOT ∏_i [max_D P_i(D)].
    // This ensures one direction must work for ALL enemies simultaneously.
    // The per-enemy future survival (surviveOne) is still factored at depth-1,
    // but the direction constraint at each level is joint.
    function survive(pR, pC, coily, enemies, depth, forcedDir) {
        if (depth <= 0) return 1.0;
        // Memoize (skip for forced dir — only called once per direction)
        var mKey;
        if (!forcedDir) {
            mKey = pR + ',' + pC + '|' + coily.row + ',' + coily.col + ',' +
                   (coily.jumping ? 1 : 0) + ',' + Math.round((coily.jumpT || 0) * 30) + ',' +
                   (coily.moveTimer || 0) + ',' + (coily.destRow != null ? coily.destRow : 9) + ',' +
                   (coily.destCol != null ? coily.destCol : 9) + '|' + depth;
            for (var mi = 0; mi < enemies.length; mi++) {
                var me = enemies[mi];
                mKey += '|' + me.type[0] + me.row + ',' + me.col + ',' + (me.jumping ? 1 : 0) + ',' +
                        Math.round((me.jumpT || 0) * 30) + ',' + me.moveTimer + ',' +
                        (me.destRow != null ? me.destRow : 9) + ',' + (me.destCol != null ? me.destCol : 9) + ',' +
                        (me.hops || 0) + ',' + (me.dirBits != null ? me.dirBits : 'n') + ',' +
                        (me.spawnAnimTimer || 0);
            }
            if (memo[mKey] !== undefined) return memo[mKey];
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
            var doBranch = true; // both-branch at all depth levels
            var branchEnemy = null;
            var branchDist = Infinity;
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
                    if (!doBranch) {
                        if (safeBranches[0]) baseEnemies.push(safeBranches[0]);
                    } else {
                    // Track nearest branching enemy for expected-value recursion
                    for (var sbi = 0; sbi < 2; sbi++) {
                        if (!safeBranches[sbi]) continue;
                        var sb = safeBranches[sbi];
                        var sbR = sb.jumping && sb.destRow != null ? sb.destRow : sb.row;
                        var sbC = sb.jumping && sb.destCol != null ? sb.destCol : sb.col;
                        var sbd = Math.abs(sbR - nr) + Math.abs(sbC - nc);
                        if (sbd < branchDist) { branchDist = sbd; branchEnemy = safeBranches; }
                    }
                    // Non-nearest branching enemies: use first safe branch
                    if (branchEnemy !== safeBranches) {
                        if (safeBranches[0]) baseEnemies.push(safeBranches[0]);
                    }
                    } // end doBranch
                }
            }
            if (prob > 0) {
                if (!branchEnemy) {
                    prob *= survive(nr, nc, newCoily, baseEnemies, depth - 1);
                } else {
                    // Expected value over nearest branching enemy's 2 branches
                    var s0 = branchEnemy[0] ? survive(nr, nc, newCoily, baseEnemies.concat([branchEnemy[0]]), depth-1) : 1;
                    var s1 = branchEnemy[1] ? survive(nr, nc, newCoily, baseEnemies.concat([branchEnemy[1]]), depth-1) : 1;
                    prob *= 0.5 * s0 + 0.5 * s1;
                }
            }
            if (prob > bestProb) bestProb = prob;
        }
        if (mKey) memo[mKey] = bestProb;
        return bestProb;
    }

    // Top-level: P(survive DEPTH hops | direction dir)
    function dirSurvivalProb(pR, pC, coily, enemies, depth, dir) {
        var d = DIRS[dir];
        var nr = pR + d.dr, nc = pC + d.dc;
        if (!isValidPos(nr, nc)) {
            for (var dci = 0; dci < gs.discs.length; dci++) {
                var disc = gs.discs[dci];
                if (!disc.active) continue;
                if ((disc.side === 0 && dir === 'UL' && pC === 0 && pR === disc.row) ||
                    (disc.side === 1 && dir === 'UR' && pC === pR && pR === disc.row))
                    return 1.0;
            }
            return 0;
        }
        // Delegate to survive with forced direction
        return survive(pR, pC, coily, enemies, depth, dir);
    }

    // (Disc lure evaluation is now folded into dirSurvivalProb above —
    // disc moves get P=1.0 and compete naturally via the scoring formula)

    // ── Core: AND-OR tree safety check per direction ──
    // For each direction: survive hop 1 (all seeds), then DFS depth-6 AND-OR tree.

    var safe1 = {};
    var safe2 = {};
    var tourCosts = {};
    var hop1Surv = {};

    for (var k = 0; k < DIR_KEYS_WITH_STAY.length; k++) {
        var dir = DIR_KEYS_WITH_STAY[k];
        if (!simCanMove(gs, dir)) continue;

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

        // Compute survival probability over DEPTH hops
        var survProb = 1.0;
        if (hasEnemies && DEPTH > 0) {
            var ci0 = coilyInit || { row:-99, col:-99, jumping:false, jumpT:0,
                moveTimer:0, destRow:null, destCol:null };
            survProb = dirSurvivalProb(gs.player.row, gs.player.col, ci0, enemyInits, DEPTH, dir);
        }
        hop1Surv[dir] = survProb;


        // Compute tour cost — if simStep dies on this RNG seed, use current state estimate
        simSeed(k * 100);
        var tcClone = simDeepClone(gs);
        var tcAlive = simStep(tcClone, dir);
        var tc;
        if (tcAlive) {
            tc = tcClone.levelWon ? 0 : simTourCost(tcClone);
        } else {
            tc = simTourCost(gs) + 1; // simStep failed with this seed; approximate
        }
        if (dir === 'STAY') tc += 2;
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

    // Safety-first: if any direction has P=1.0, never gamble on P<1.0
    var hasPerfect = false;
    for (var sk in hop1Surv) { if (hop1Surv[sk] >= 1.0 && aiMoveScores[sk] !== undefined) { hasPerfect = true; break; } }
    if (hasPerfect) {
        for (var sk2 in hop1Surv) {
            if (hop1Surv[sk2] < 1.0 && aiMoveScores[sk2] !== undefined && aiMoveScores[sk2] > -10000) {
                aiMoveScores[sk2] = -10000;
            }
        }
    }

    aiLastHop1Surv = hop1Surv;
    aiLastTourCosts = tourCosts;

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
    if (_perfMs > 50) console.log('AI SLOW: ' + _perfMs.toFixed(0) + 'ms, enemies=' + enemyInits.length + ' memo=' + Object.keys(memo).length);
    return bestDir || 'STAY';
}

// ─── Main entry point ────────────────────────────────────────────────────────
var aiMoveScores = {};  // exported per-direction scores for viz
var aiLastTourCosts = {};  // last per-direction tour costs from unifiedPick
var aiLastHop1Surv = {};   // last hop-1 survival rates from unifiedPick
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
    aiMoveScores = {};
    aiMode = 1;

    // Track how long we've been on the same tile
    var posKey = gs.player.row + ',' + gs.player.col;
    if (posKey === aiLastPos) aiSamePosCount++;
    else { aiSamePosCount = 0; aiLastPos = posKey; }

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

    // Break stuck STAY loops
    if (result === 'STAY') {
        aiStayCount++;
        if (aiStayCount >= 3) {
            var bestAlt = null, bestAltScore = -Infinity;
            for (var k = 0; k < DIR_KEYS.length; k++) {
                if (simCanMove(gs, DIR_KEYS[k])) {
                    var sc = aiMoveScores[DIR_KEYS[k]];
                    if (sc !== undefined && sc < 0) continue;
                    if (sc !== undefined && sc > bestAltScore) {
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
