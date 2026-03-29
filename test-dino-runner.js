#!/usr/bin/env node
// Dino Runner AI headless test — runs the game in a headless browser via Playwright
// Usage: node test-dino-runner.js [seconds] [maxSpeed]

var { chromium } = require('playwright');
var http = require('http');
var fs = require('fs');
var path = require('path');

var testSeconds = 60;
var maxSpeed = 30;
var nums = [];
for (var i = 2; i < process.argv.length; i++) {
    var n = parseInt(process.argv[i]);
    if (!isNaN(n) && n > 0) nums.push(n);
}
if (nums.length >= 1) testSeconds = nums[0];
if (nums.length >= 2) maxSpeed = nums[1];

var MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
             '.json': 'application/json', '.png': 'image/png' };

function startServer(dir) {
    return new Promise(function(resolve) {
        var server = http.createServer(function(req, res) {
            var url = req.url.split('?')[0];
            var filePath = path.join(dir, url === '/' ? 'index.html' : url);
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

    var crashes = [];
    page.on('console', function(msg) {
        var text = msg.text();
        if (text.startsWith('CRASH') || text.startsWith('NO JUMP')) {
            crashes.push(text);
            console.log('  ' + text);
        }
    });
    page.on('pageerror', function(err) { console.error('PAGE ERROR:', err.message); });

    await page.goto(baseUrl + '/dino-runner.html');
    // Wait for the page's own initialization to complete (sets window.runner)
    await page.waitForFunction('!!window.runner', { timeout: 15000 });

    // Set slider value first, then enable AI (setMode reads the slider)
    await page.evaluate(function(opts) {
        var sl = document.getElementById('max-speed-slider');
        if (sl) { sl.value = opts.maxSpeed; }
        var sv = document.getElementById('max-speed-val');
        if (sv) { sv.textContent = opts.maxSpeed; }

        window.setMode('rules');

        // Ensure config matches (setMode reads slider, but belt-and-suspenders)
        var r = window.runner;
        r.config.MAX_SPEED = opts.maxSpeed;
        var ratio = opts.maxSpeed / 13;
        r.config.ACCELERATION = 0.002 * ratio * ratio;
    }, { maxSpeed: maxSpeed });

    console.log('Running dino runner AI for ' + testSeconds + 's at max speed ' + maxSpeed + '...\n');

    var startTime = Date.now();
    var lastScore = 0;
    var bestScore = 0;
    var totalDeaths = 0;
    var scores = [];

    while (Date.now() - startTime < testSeconds * 1000) {
        var state = await page.evaluate(function() {
            var r = Runner.instance_;
            var agent = window._simAgent;
            return {
                score: Math.round(r.distanceRan * 0.025),
                speed: r.currentSpeed,
                crashed: r.crashed,
                playing: r.playing,
                deaths: agent ? agent.deaths : 0,
                bestScore: agent ? agent.bestScore : 0
            };
        });

        if (state.deaths > totalDeaths) {
            // A new crash happened
            scores.push(lastScore);
            totalDeaths = state.deaths;
        }

        lastScore = state.score;
        if (state.score > bestScore) bestScore = state.score;

        // Print progress every 10s
        var elapsed = Math.round((Date.now() - startTime) / 1000);
        if (elapsed % 10 === 0) {
            process.stdout.write('\r  ' + elapsed + 's | score=' + state.score +
                ' spd=' + state.speed.toFixed(1) +
                ' deaths=' + state.deaths +
                ' best=' + Math.max(bestScore, state.bestScore) + '    ');
        }

        await page.waitForTimeout(500);
    }

    // Final state
    var final = await page.evaluate(function() {
        var r = Runner.instance_;
        var agent = window._simAgent;
        return {
            score: Math.round(r.distanceRan * 0.025),
            deaths: agent ? agent.deaths : 0,
            bestScore: agent ? agent.bestScore : 0
        };
    });
    if (final.score > 0) scores.push(final.score);

    console.log('\n\n=== RESULTS ===');
    console.log('Duration: ' + testSeconds + 's');
    console.log('Max speed: ' + maxSpeed);
    console.log('Total deaths: ' + final.deaths);
    console.log('Best score: ' + Math.max(bestScore, final.bestScore));
    if (scores.length > 0) {
        var avg = scores.reduce(function(a, b) { return a + b; }, 0) / scores.length;
        console.log('Avg score: ' + Math.round(avg));
        console.log('Scores: ' + scores.join(', '));
    }

    var pass = final.deaths === 0 || (scores.length > 0 && Math.max.apply(null, scores) > 500);
    console.log('\n' + (pass ? 'PASS' : 'FAIL') +
        (final.deaths === 0 ? ' (no deaths!)' : ''));

    await browser.close();
    srv.server.close();
    process.exit(pass ? 0 : 1);
})().catch(function(err) {
    console.error(err);
    process.exit(1);
});
