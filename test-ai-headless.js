#!/usr/bin/env node
// Q*bert AI headless test — runs the real game in a headless browser via Playwright
// Usage: node test-ai-headless.js [rounds] [--no-enemies] [-v]

var { chromium } = require('playwright');
var http = require('http');
var fs = require('fs');
var path = require('path');

var numRounds = 16;
var noEnemies = false;
var verbose = false;
var debug = false;
for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--no-enemies') noEnemies = true;
    else if (process.argv[i] === '-v' || process.argv[i] === '--verbose') verbose = true;
    else if (process.argv[i] === '-d' || process.argv[i] === '--debug') debug = true;
    else { var n = parseInt(process.argv[i]); if (!isNaN(n) && n > 0) numRounds = n; }
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

(async () => {
    var srv = await startServer(__dirname);
    var baseUrl = 'http://localhost:' + srv.port;

    var browser = await chromium.launch({ headless: true });
    var page = await browser.newPage();

    if (verbose) {
        page.on('console', function(msg) { console.log('BROWSER:', msg.text()); });
    }
    page.on('pageerror', function(err) { console.log('PAGE ERROR:', err.message); });

    await page.goto(baseUrl + '/dino-qbert.html');
    await page.waitForFunction('typeof restartGame === "function"', { timeout: 15000 });

    // Configure: max speed, enable AI, inject round-completion hook
    await page.evaluate(function(opts) {
        window.setGameSpeed(8);
        window.setMode('rules');
        window._headlessTest = true;
        window._predValidate = true;
        if (opts.noEnemies) window.toggleEnemies();

        // Hook: capture round results when level completes
        window._roundResults = [];
        window._deathLog = window._deathLog || [];

        // Poll levelWon flag to capture hops before reset
        var _lastLevelWon = false;
        setInterval(function() {
            if (typeof levelWon !== 'undefined' && levelWon && !_lastLevelWon) {
                window._roundResults.push({
                    level: arcadeLevel(),
                    roundInLevel: ((round - 1) % 4 + 1),
                    hops: hops,
                    score: score,
                    deaths: (window._deathLog || []).length
                });
            }
            _lastLevelWon = (typeof levelWon !== 'undefined') ? levelWon : false;
        }, 16);
    }, { noEnemies: noEnemies });

    console.log('Running AI test for ' + numRounds + ' rounds' + (noEnemies ? ' (no enemies)' : '') + '...\n');

    var startTime = Date.now();
    var lastResultCount = 0;

    while (true) {
        var state = await page.evaluate(function() {
            return {
                roundResults: window._roundResults || [],
                gameOver: typeof gameOver !== 'undefined' ? gameOver : false,
                deathLog: window._deathLog || [],
                score: typeof score !== 'undefined' ? score : 0,
                round: typeof round !== 'undefined' ? round : 0
            };
        });

        // Print new round results
        for (var ri = lastResultCount; ri < state.roundResults.length; ri++) {
            var r = state.roundResults[ri];
            var roundDeaths = ri === 0 ? r.deaths : r.deaths - state.roundResults[ri - 1].deaths;
            console.log('Lv' + r.level + '-' + r.roundInLevel + ': ' + r.hops + ' hops' +
                (roundDeaths > 0 ? ' (' + roundDeaths + ' deaths)' : '') + ', score=' + r.score);
        }
        lastResultCount = state.roundResults.length;

        if (lastResultCount >= numRounds) break;

        if (state.gameOver) {
            console.log('GAME OVER, score=' + state.score + '. Restarting...\n');
            await page.evaluate(function() {
                window.setMode('rules');
                restartGame();
            });
        }

        if (Date.now() - startTime > 5 * 60 * 1000) {
            console.log('TIMEOUT after 5 minutes');
            break;
        }

        await page.waitForTimeout(200);
    }

    // Final summary
    var final = await page.evaluate(function() {
        return { roundResults: window._roundResults || [], deathLog: window._deathLog || [],
                 deathChains: window._deathChains || [] };
    });

    var results = final.roundResults;
    console.log('\n=== SUMMARY ===');
    console.log('Rounds completed: ' + results.length);
    console.log('Total deaths: ' + final.deathLog.length);
    if (results.length > 0) {
        var avgHops = results.reduce(function(s, r) { return s + r.hops; }, 0) / results.length;
        console.log('Avg hops/round: ' + avgHops.toFixed(1));
        console.log('\nPer-round:');
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            var rd = i === 0 ? r.deaths : r.deaths - results[i - 1].deaths;
            console.log('  Lv' + r.level + '-' + r.roundInLevel + ': ' + r.hops + ' hops' +
                (rd > 0 ? ' (' + rd + ' deaths)' : ''));
        }
    }
    if (final.deathLog.length > 0) {
        console.log('\nDeath log:');
        for (var i = 0; i < final.deathLog.length; i++) console.log('  ' + final.deathLog[i]);
        if (debug) {
            console.log('\nDeath chains:');
            for (var i = 0; i < final.deathChains.length; i++) {
                var dc = final.deathChains[i];
                console.log('  --- Death ' + (i+1) + ': ' + dc.info.substring(0, 80));
                for (var j = 0; j < dc.chain.length; j++) {
                    var c = dc.chain[j];
                    console.log('    hop=' + c.hop + ' ' + c.pos + ' ' + c.dir + ' P=[' + c.probs + '] ' + c.enemies);
                }
            }
        }
    }

    await browser.close();
    srv.server.close();
})().catch(function(err) {
    console.error(err);
    process.exit(1);
});
