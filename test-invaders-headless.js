#!/usr/bin/env node
// Space Invaders AI headless test — runs games via Playwright to measure performance
// Usage: node test-invaders-headless.js [games] [--sweep]

var { chromium } = require('playwright');
var http = require('http');
var fs = require('fs');
var path = require('path');

var numGames = 3;
var sweep = false;
for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--sweep') sweep = true;
    else { var n = parseInt(process.argv[i]); if (!isNaN(n) && n > 0) numGames = n; }
}

var MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

function startServer(dir) {
    return new Promise(function(resolve) {
        var server = http.createServer(function(req, res) {
            var filePath = path.join(dir, req.url === '/' ? 'index.html' : req.url);
            var ext = path.extname(filePath);
            fs.readFile(filePath, function(err, data) {
                if (err) { res.writeHead(404); res.end('Not found'); return; }
                res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
                res.end(data);
            });
        });
        server.listen(0, function() {
            resolve({ server: server, port: server.address().port });
        });
    });
}

async function runGames(page, nGames, params) {
    // Set parameters and start with turbo loop
    await page.evaluate(function(p) {
        window.game.restart();
        window.setMode('rules');
        // Override danger params
        if (p) window._dangerParams = p;
        window._gameResults = [];
        // Turbo: run many updates per rAF
        window.game.speedMultiplier = 200;
    }, params);

    var results = [];
    var startTime = Date.now();
    var timeout = nGames * 30 * 1000; // 30s per game max

    while (results.length < nGames) {
        var state = await page.evaluate(function() {
            var g = window.game;
            return {
                wave: g.wave,
                score: g.score,
                lives: g.lives,
                gameOver: g.gameOver,
                results: window._gameResults
            };
        });

        if (state.gameOver) {
            results.push({ wave: state.wave, score: state.score });
            if (results.length < nGames) {
                await page.evaluate(function() {
                    window.game.restart();
                    window.setMode('rules');
                    window.game.speedMultiplier = 200;
                });
            }
        }

        if (Date.now() - startTime > timeout) {
            // Record current game as incomplete
            results.push({ wave: state.wave, score: state.score, timeout: true });
            break;
        }

        await page.waitForTimeout(100);
    }
    return results;
}

(async () => {
    var srv = await startServer(__dirname);
    var baseUrl = 'http://localhost:' + srv.port;

    var browser = await chromium.launch({ headless: true });
    var page = await browser.newPage();
    page.on('pageerror', function(err) { console.log('PAGE ERROR:', err.message); });

    await page.goto(baseUrl + '/dino-invaders.html');
    await page.waitForFunction('typeof window.game !== "undefined" && typeof window.setMode === "function"', { timeout: 15000 });

    if (sweep) {
        // Parameter sweep
        var configs = [
            { name: 'base=24', base: 24, aliveScale: 0.5, waveScale: 2, waveCap: 24 },
            { name: 'base=48', base: 48, aliveScale: 0.5, waveScale: 2, waveCap: 24 },
            { name: 'base=72', base: 72, aliveScale: 0.5, waveScale: 2, waveCap: 24 },
            { name: 'base=48,alive=1', base: 48, aliveScale: 1.0, waveScale: 2, waveCap: 24 },
            { name: 'base=48,alive=1.5', base: 48, aliveScale: 1.5, waveScale: 2, waveCap: 24 },
            { name: 'base=48,wave=4', base: 48, aliveScale: 0.5, waveScale: 4, waveCap: 48 },
            { name: 'base=48,wave=6', base: 48, aliveScale: 0.5, waveScale: 6, waveCap: 72 },
            { name: 'base=72,alive=1,wave=4', base: 72, aliveScale: 1.0, waveScale: 4, waveCap: 48 },
        ];

        console.log('=== DANGER PARAMETER SWEEP (' + numGames + ' games each) ===\n');
        for (var ci = 0; ci < configs.length; ci++) {
            var cfg = configs[ci];
            var results = await runGames(page, numGames, cfg);
            var avgWave = results.reduce(function(s, r) { return s + r.wave; }, 0) / results.length;
            var avgScore = results.reduce(function(s, r) { return s + r.score; }, 0) / results.length;
            var maxWave = results.reduce(function(s, r) { return Math.max(s, r.wave); }, 0);
            console.log(cfg.name + ': avg wave=' + avgWave.toFixed(1) + ' max=' + maxWave + ' avg score=' + Math.round(avgScore) +
                ' [' + results.map(function(r) { return 'w' + r.wave + (r.timeout ? '!' : ''); }).join(', ') + ']');
        }
    } else {
        console.log('Running ' + numGames + ' games...\n');
        var results = await runGames(page, numGames, null);
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            console.log('Game ' + (i + 1) + ': wave ' + r.wave + ', score ' + r.score + (r.timeout ? ' (timeout)' : ''));
        }
        var avgWave = results.reduce(function(s, r) { return s + r.wave; }, 0) / results.length;
        var avgScore = results.reduce(function(s, r) { return s + r.score; }, 0) / results.length;
        console.log('\nAvg wave: ' + avgWave.toFixed(1) + ', Avg score: ' + Math.round(avgScore));
    }

    await browser.close();
    srv.server.close();
})().catch(function(err) {
    console.error(err);
    process.exit(1);
});
