// Breakout AI Search Worker — runs deep lookahead search off the main thread
// Receives search requests, posts back results at each depth as they complete.
// Uses setTimeout(0) between depth levels so new messages can cancel stale searches.

var G; // game constants, set on init

function brickRect(r, c) {
    return {
        x: G.BRICK_LEFT + c * (G.BRICK_W + G.BRICK_GAP),
        y: G.BRICK_TOP + r * (G.BRICK_H + G.BRICK_GAP),
        w: G.BRICK_W, h: G.BRICK_H
    };
}

function simBallFlight(bx, by, bvx, bvy, bricksIn, maxFrames) {
    var bricks = [], initialBricks = 0;
    for (var r = 0; r < G.ROWS; r++) {
        bricks[r] = [];
        for (var c = 0; c < G.COLS; c++) {
            bricks[r][c] = bricksIn[r][c];
            if (bricksIn[r][c]) initialBricks++;
        }
    }
    var hits = 0, path = [], allCleared = (initialBricks === 0);
    for (var f = 0; f < maxFrames; f++) {
        var spd = Math.max(Math.abs(bvx), Math.abs(bvy));
        var nSub = Math.max(1, Math.ceil(spd / (G.BALL_SZ * 0.8)));
        var dxS = bvx / nSub, dyS = bvy / nSub;
        for (var s = 0; s < nSub; s++) {
            bx += dxS; by += dyS;
            if (bx < 0) { bx = -bx; bvx = Math.abs(bvx); dxS = Math.abs(dxS); }
            if (bx > G.CW - G.BALL_SZ) { bx = 2 * (G.CW - G.BALL_SZ) - bx; bvx = -Math.abs(bvx); dxS = -Math.abs(dxS); }
            if (by < 0) { by = -by; bvy = Math.abs(bvy); dyS = Math.abs(dyS); }

            for (var r = 0; r < G.ROWS; r++) {
                for (var c = 0; c < G.COLS; c++) {
                    if (!bricks[r][c]) continue;
                    var br = brickRect(r, c);
                    if (bx + G.BALL_SZ > br.x && bx < br.x + br.w &&
                        by + G.BALL_SZ > br.y && by < br.y + br.h) {
                        bricks[r][c] = false;
                        hits++;
                        var oL = (bx + G.BALL_SZ) - br.x, oR = (br.x + br.w) - bx;
                        var oT = (by + G.BALL_SZ) - br.y, oB = (br.y + br.h) - by;
                        if (Math.min(oT, oB) < Math.min(oL, oR)) {
                            bvy = -bvy; dyS = -dyS;
                            if (oT < oB) by = br.y - G.BALL_SZ; else by = br.y + br.h;
                        } else {
                            bvx = -bvx; dxS = -dxS;
                            if (oL < oR) bx = br.x - G.BALL_SZ; else bx = br.x + br.w;
                        }
                        if (hits >= initialBricks) { allCleared = true; path.push({ x: bx, y: by }); }
                        s = nSub; r = G.ROWS; break;
                    }
                }
            }

            if (bvy > 0 && by + G.BALL_SZ >= G.PAD_Y && by < G.PAD_Y + G.PAD_H) {
                if (!allCleared) path.push({ x: bx, y: by });
                return { caught: true, lost: false, frames: f + 1,
                    bx: bx, by: by, bvx: bvx, bvy: bvy,
                    hits: hits, bricks: bricks, path: path };
            }
            if (by > G.CH + 20) {
                if (!allCleared) path.push({ x: bx, y: by });
                return { caught: false, lost: true, frames: f + 1,
                    bx: bx, by: by, bvx: bvx, bvy: bvy,
                    hits: hits, bricks: bricks, path: path };
            }
        }
        if (!allCleared) path.push({ x: bx, y: by });
    }
    return { caught: false, lost: false, frames: maxFrames,
        bx: bx, by: by, bvx: bvx, bvy: bvy,
        hits: hits, bricks: bricks, path: path };
}

function evalFlight(flight, padX, padW, sm, bricksRemaining, depth, maxDepth, beam) {
    var hits = flight.hits;

    if (!flight.caught) {
        return { score: hits + (flight.lost ? -100 : 0), bestPath: [] };
    }
    if (hits >= bricksRemaining) {
        return { score: hits + 50, bestPath: [] };
    }
    if (depth >= maxDepth) {
        var F = flight.frames;
        var rMin = Math.max(0, padX - F * G.PAD_SPEED);
        var rMax = Math.min(G.CW - padW, padX + F * G.PAD_SPEED);
        var canCatch = flight.bx + G.BALL_SZ > rMin && flight.bx < rMax + padW;
        return { score: hits + (canCatch ? 0.5 : -100), bestPath: [] };
    }

    var cbx = flight.bx;
    var F = flight.frames;
    var catchLo = cbx - padW + 1;
    var catchHi = cbx + G.BALL_SZ - 1;
    var kMin = Math.ceil((Math.max(0, catchLo) - padX) / G.PAD_SPEED);
    var kMax = Math.floor((Math.min(G.CW - padW, catchHi) - padX) / G.PAD_SPEED);
    kMin = Math.max(kMin, -F);
    kMax = Math.min(kMax, F);

    var cands = [];
    for (var k = kMin; k <= kMax; k++) {
        var p = padX + k * G.PAD_SPEED;
        if (p < 0 || p > G.CW - padW || p < catchLo || p > catchHi) continue;
        var hitPos = (cbx + G.BALL_SZ / 2 - p) / padW;
        var newBvx = G.BALL_SPEED * sm * (hitPos - 0.5) * 2.5;
        var newBvy = -Math.abs(flight.bvy);
        var nextFlight = simBallFlight(cbx, G.PAD_Y - G.BALL_SZ,
            newBvx, newBvy, flight.bricks, 1000);
        cands.push({ p: p, flight: nextFlight, sortKey: nextFlight.hits });
    }

    if (cands.length === 0) {
        return { score: hits - 100, bestPath: [] };
    }

    cands.sort(function (a, b) { return b.sortKey - a.sortKey; });
    if (cands.length > beam) cands.length = beam;

    var bestScore = -999, bestImmHits = Infinity, bestPath = [];
    for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        var sub = evalFlight(c.flight, c.p, padW, sm,
            bricksRemaining - hits, depth + 1, maxDepth, beam);
        var score = hits + sub.score;
        // Prefer fewer immediate hits as tiebreaker (encourages tunneling)
        if (score > bestScore + 0.1 ||
            (score > bestScore - 0.1 && c.flight.hits < bestImmHits)) {
            bestScore = score;
            bestImmHits = c.flight.hits;
            // Store {p, flight} so the game can follow the planned sequence
            bestPath = [{ p: c.p, flight: c.flight }].concat(sub.bestPath);
        }
    }

    return { score: bestScore, bestPath: bestPath };
}

var searchId = 0; // incremented on each new search to cancel stale ones

self.onmessage = function (e) {
    var msg = e.data;

    if (msg.type === 'init') {
        G = msg.constants;
        return;
    }

    if (msg.type === 'search') {
        searchId = msg.id;
        // Kick off async iterative deepening
        startSearch(msg);
    }
};

function startSearch(msg) {
    var id = msg.id;
    var bx = msg.bx, by = msg.by, bvx = msg.bvx, bvy = msg.bvy;
    var bricks = msg.bricks;
    var px = msg.px, padW = msg.padW, sm = msg.sm;
    var bricksLeft = msg.bricksLeft;
    var BEAM = 5;

    // Simulate flight1
    var flight1 = simBallFlight(bx, by, bvx, bvy, bricks, 1000);

    if (!flight1.caught) {
        self.postMessage({ type: 'result', id: id, depth: 0,
            caught: false, bestP: -1, bestScore: 0, bestPath: null,
            candidates: [], flight1: flight1 });
        return;
    }

    // Enumerate first-catch candidates
    var F = flight1.frames;
    var cbx = flight1.bx;
    var catchLo = cbx - padW + 1;
    var catchHi = cbx + G.BALL_SZ - 1;
    var kMin = Math.ceil((Math.max(0, catchLo) - px) / G.PAD_SPEED);
    var kMax = Math.floor((Math.min(G.CW - padW, catchHi) - px) / G.PAD_SPEED);
    kMin = Math.max(kMin, -F);
    kMax = Math.min(kMax, F);

    var firstCands = [];
    for (var k = kMin; k <= kMax; k++) {
        var p = px + k * G.PAD_SPEED;
        if (p < 0 || p > G.CW - padW || p < catchLo || p > catchHi) continue;
        var hitPos = (cbx + G.BALL_SZ / 2 - p) / padW;
        var newBvx = G.BALL_SPEED * sm * (hitPos - 0.5) * 2.5;
        var newBvy = -Math.abs(flight1.bvy);
        var f2 = simBallFlight(cbx, G.PAD_Y - G.BALL_SZ,
            newBvx, newBvy, flight1.bricks, 1000);
        firstCands.push({ p: p, flight2: f2 });
    }

    // Iterative deepening — yield between depths so new messages can cancel us
    searchDepthStep(id, firstCands, flight1, px, padW, sm, bricksLeft, BEAM, 0);
}

function searchDepthStep(id, firstCands, flight1, px, padW, sm, bricksLeft, BEAM, maxDepth) {
    // Check if cancelled (a newer search arrived while we yielded)
    if (searchId !== id) return;
    if (maxDepth > 30) {
        self.postMessage({ type: 'done', id: id });
        return;
    }

    var depthBestP = -1, depthBestScore = -999, depthBestImmHits = Infinity;
    var depthBestPath = null;
    var depthCands = [];

    for (var i = 0; i < firstCands.length; i++) {
        var fc = firstCands[i];
        var sub = evalFlight(fc.flight2, fc.p, padW, sm,
            bricksLeft - flight1.hits, 1, maxDepth, BEAM);
        var score = flight1.hits + sub.score;
        depthCands.push({ p: fc.p, score: score });
        // Prefer fewer immediate hits as tiebreaker (encourages tunneling)
        if (score > depthBestScore + 0.1 ||
            (score > depthBestScore - 0.1 && fc.flight2.hits < depthBestImmHits)) {
            depthBestScore = score;
            depthBestImmHits = fc.flight2.hits;
            depthBestP = fc.p;
            // Store {p, flight} so the game can follow the planned sequence
            depthBestPath = [{ p: fc.p, flight: fc.flight2 }].concat(sub.bestPath);
        }
    }

    // Post intermediate result
    self.postMessage({
        type: 'result', id: id,
        caught: true,
        depth: maxDepth + 1,
        bestP: depthBestP,
        bestScore: depthBestScore,
        bestPath: depthBestPath,
        candidates: depthCands,
        flight1: flight1
    });

    // Yield to event loop before next depth — allows new messages to update searchId
    setTimeout(function () {
        searchDepthStep(id, firstCands, flight1, px, padW, sm, bricksLeft, BEAM, maxDepth + 1);
    }, 0);
}
