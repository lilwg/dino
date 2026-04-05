#!/usr/bin/env node
// Runs the real game with window.AI_TEACHER=true (teacher as realtime AI).
// Reports per-decision timing distribution + deaths across N rounds.
// Usage: node test-teacher-ai.js [rounds] [--depth N] [--mc N]

var { chromium } = require('playwright');
var http = require('http');
var fs = require('fs');
var path = require('path');

var numRounds = 16;
var depth = 8;
var mcSamples = 128;
for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--depth') depth = parseInt(process.argv[++i]);
    else if (process.argv[i] === '--mc') mcSamples = parseInt(process.argv[++i]);
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
        server.listen(0, function() { resolve({ server: server, port: server.address().port }); });
    });
}

function percentile(arr, p) {
    if (arr.length === 0) return 0;
    var sorted = arr.slice().sort(function(a, b) { return a - b; });
    var idx = Math.floor(sorted.length * p);
    return sorted[Math.min(idx, sorted.length - 1)];
}

(async () => {
    var srv = await startServer(__dirname);
    var baseUrl = 'http://localhost:' + srv.port;
    var browser = await chromium.launch({ headless: true });
    var page = await browser.newPage();
    page.on('pageerror', function(err) { console.log('PAGE ERROR:', err.message); });
    page.on('console', function(msg) {
        var t = msg.text();
        if (t.indexOf('DEBUG:') === 0 || t.indexOf('TEACHER:') === 0 ||
            t.indexOf('PRED-FAIL') === 0 || t.indexOf('PRE-STATE') === 0 ||
            t.indexOf('SNAPSHOT') === 0 || t.indexOf('DOOM-ENTRY') === 0 ||
            t.indexOf('DOOM-CUR') === 0) console.log('B:', t);
    });

    await page.goto(baseUrl + '/dino-qbert.html');
    await page.waitForFunction('typeof restartGame === "function"', { timeout: 15000 });

    await page.evaluate(function(opts) {
        window.setGameSpeed(8);
        window.setMode('rules');
        window._headlessTest = true;
        window._predValidate = true;
        window.AI_TEACHER = true;
        window.AI_DEPTH = opts.depth;
        window.AI_TEACHER_MC = opts.mcSamples;
        window._teacherTimings = [];
        window._roundResults = [];
        // Debug check
        console.log('DEBUG: AI_TEACHER=' + window.AI_TEACHER +
                    ' perfectTeacherEval=' + (typeof perfectTeacherEval) +
                    ' perfectTeacherReset=' + (typeof perfectTeacherReset));
        var _lastLevelWon = false;
        setInterval(function() {
            if (typeof levelWon !== 'undefined' && levelWon && !_lastLevelWon) {
                window._roundResults.push({
                    level: arcadeLevel(),
                    roundInLevel: ((round - 1) % 4 + 1),
                    hops: hops, score: score,
                    deaths: (window._deathLog || []).length
                });
            }
            _lastLevelWon = (typeof levelWon !== 'undefined') ? levelWon : false;
        }, 16);
    }, { depth: depth, mcSamples: mcSamples });

    console.log('Teacher AI: depth=' + depth + ' mcSamples=' + mcSamples);
    console.log('Running ' + numRounds + ' rounds...\n');

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
            await page.evaluate(function() { window.setMode('rules'); restartGame(); });
        }
        if (Date.now() - startTime > 10 * 60 * 1000) { console.log('TIMEOUT'); break; }
        await page.waitForTimeout(200);
    }

    var final = await page.evaluate(function() {
        return {
            roundResults: window._roundResults || [],
            deathLog: window._deathLog || [],
            timings: window._teacherTimings || [],
            deathChains: window._deathChains || []
        };
    });

    console.log('\n=== SUMMARY ===');
    console.log('Rounds completed: ' + final.roundResults.length);
    console.log('Total deaths: ' + final.deathLog.length);
    if (final.roundResults.length > 0) {
        var avgHops = final.roundResults.reduce(function(s, r) { return s + r.hops; }, 0) / final.roundResults.length;
        console.log('Avg hops/round: ' + avgHops.toFixed(1));
    }

    // Timing distribution
    var allMs = final.timings.map(function(t) { return t.ms; });
    var spawnMs = final.timings.filter(function(t) { return t.hasSpawnTimer; }).map(function(t) { return t.ms; });
    var noSpawnMs = final.timings.filter(function(t) { return !t.hasSpawnTimer; }).map(function(t) { return t.ms; });

    console.log('\n=== TIMING (per AI call, ms) ===');
    console.log('samples: ' + allMs.length);
    console.log('all:      p50=' + percentile(allMs, 0.5).toFixed(1) +
                ' p90=' + percentile(allMs, 0.9).toFixed(1) +
                ' p99=' + percentile(allMs, 0.99).toFixed(1) +
                ' max=' + percentile(allMs, 1.0).toFixed(1));
    console.log('no-spawn: ' + noSpawnMs.length + ' calls, p50=' +
                percentile(noSpawnMs, 0.5).toFixed(1) + ' p99=' +
                percentile(noSpawnMs, 0.99).toFixed(1) + ' max=' +
                percentile(noSpawnMs, 1.0).toFixed(1));
    console.log('w/ spawn: ' + spawnMs.length + ' calls, p50=' +
                percentile(spawnMs, 0.5).toFixed(1) + ' p99=' +
                percentile(spawnMs, 0.99).toFixed(1) + ' max=' +
                percentile(spawnMs, 1.0).toFixed(1));

    // Budget violations
    var over80 = allMs.filter(function(m) { return m > 80; }).length;
    var over200 = allMs.filter(function(m) { return m > 200; }).length;
    console.log('budget violations: >80ms=' + over80 + ' (' +
                (100 * over80 / allMs.length).toFixed(1) + '%), >200ms=' + over200);
    var depthCounts = {};
    for (var ti2 = 0; ti2 < final.timings.length; ti2++) {
        var rd = final.timings[ti2].reachedDepth || 0;
        depthCounts[rd] = (depthCounts[rd] || 0) + 1;
    }
    console.log('\n=== reached depth distribution ===');
    Object.keys(depthCounts).sort(function(a,b){return a-b;}).forEach(function(k) {
        console.log('depth ' + k + ': ' + depthCounts[k] + ' calls (' +
                    (100*depthCounts[k]/final.timings.length).toFixed(1) + '%)');
    });

    // Enemy-count distribution
    var byCount = {};
    for (var ti = 0; ti < final.timings.length; ti++) {
        var t = final.timings[ti];
        if (!byCount[t.nEnemies]) byCount[t.nEnemies] = [];
        byCount[t.nEnemies].push(t.ms);
    }
    console.log('\n=== by enemy count ===');
    Object.keys(byCount).sort(function(a, b) { return a - b; }).forEach(function(k) {
        var arr = byCount[k];
        console.log('n=' + k + ': ' + arr.length + ' calls, p50=' +
                    percentile(arr, 0.5).toFixed(1) + ' p99=' +
                    percentile(arr, 0.99).toFixed(1) + ' max=' +
                    percentile(arr, 1.0).toFixed(1));
    });

    if (final.deathLog.length > 0) {
        console.log('\n=== deaths ===');
        for (var di = 0; di < final.deathLog.length; di++) console.log('  ' + final.deathLog[di]);
    }
    if (final.deathChains.length > 0) {
        console.log('\n=== death chains (last 8 decisions per death) ===');
        for (var dci = 0; dci < final.deathChains.length; dci++) {
            var dc = final.deathChains[dci];
            console.log('\n--- DEATH ' + (dci+1) + ' ---');
            console.log(dc.info);
            for (var ci = 0; ci < dc.chain.length; ci++) {
                var c = dc.chain[ci];
                console.log('  hop=' + c.hop + ' @' + c.pos + ' →' + c.dir +
                            ' P=[' + c.probs + ']  ' + c.enemies);
            }
        }
    }

    await browser.close();
    srv.server.close();
})().catch(function(err) { console.error(err); process.exit(1); });
