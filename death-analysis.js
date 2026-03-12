#!/usr/bin/env node
// Death analysis — instruments test-ai.js to capture death context

// Load and eval test-ai.js code, but skip the main execution
var fs = require('fs');
var src = fs.readFileSync(__dirname + '/test-ai.js', 'utf8');

// Remove the main execution block at the bottom
src = src.replace(/\/\/ ─── Main ─[\s\S]*$/, '');

eval(src);

// Now run instrumented games
var NUM_GAMES = 20;
var MAX_ROUNDS = 10;
var allDeaths = [];

for (var g = 0; g < NUM_GAMES; g++) {
    round = 1;
    score = 0;
    lives = 3;
    extraLifeGiven = false;

    for (; round <= MAX_ROUNDS; round++) {
        initRound();
        var moveNum = 0;
        var recentMoves = [];

        for (var frame = 0; frame < 20000; frame++) {
            var prevAlive = !player.dead;
            var prevRow = player.row, prevCol = player.col;
            var prevJumping = player.jumping;
            
            // Snapshot enemies before frame
            var enemySnap = [];
            for (var ei = 0; ei < enemies.length; ei++) {
                var e = enemies[ei];
                if (e.type === 'spawn-timer') continue;
                enemySnap.push({ type: e.type, row: e.row, col: e.col, jumping: e.jumping });
            }

            var aiMove = simFrame();

            if (aiMove) {
                moveNum++;
                recentMoves.push({
                    move: moveNum, frame: frame, dir: aiMove,
                    pRow: player.row, pCol: player.col,
                    remaining: countRemaining(),
                    enemies: enemySummary()
                });
                if (recentMoves.length > 8) recentMoves.shift();
            }

            if (prevAlive && player.dead) {
                // Death happened this frame!
                var deathInfo = {
                    game: g + 1, round: round, frame: frame, moveNum: moveNum,
                    playerPos: prevRow + ',' + prevCol,
                    playerJumping: prevJumping,
                    playerNewPos: player.row + ',' + player.col,
                    enemiesAtDeath: enemySnap,
                    recentMoves: recentMoves.slice(),
                    remaining: countRemaining(),
                    livesLeft: lives
                };
                
                // Determine cause
                var cause = 'unknown';
                // Check if player fell off
                if (!isValidPos(player.row, player.col)) {
                    cause = 'fell_off_board';
                } else {
                    // Check which enemy killed us
                    for (var ei2 = 0; ei2 < enemySnap.length; ei2++) {
                        var es = enemySnap[ei2];
                        if (es.type === 'greenball' || es.type === 'slick') continue;
                        if (es.row === player.row && es.col === player.col) {
                            cause = 'landed_on_' + es.type;
                        }
                        // Check if enemy landed on us
                        if (es.row === prevRow && es.col === prevCol) {
                            cause = es.type + '_landed_on_us';
                        }
                    }
                    // Also check current enemies
                    for (var ei3 = 0; ei3 < enemies.length; ei3++) {
                        var ec = enemies[ei3];
                        if (ec.type === 'spawn-timer') continue;
                        if (ec.type === 'greenball' || ec.type === 'slick') continue;
                        if (ec.row === player.row && ec.col === player.col) {
                            cause = 'killed_by_' + ec.type + '_at_' + ec.row + ',' + ec.col;
                        }
                    }
                }
                deathInfo.cause = cause;
                allDeaths.push(deathInfo);
            }

            if (lives <= 0) break;
            if (levelWon) { break; }
        }
        if (lives <= 0) break;
        if (levelWon) round--; // for-loop will increment
    }
}

// Summary
console.log('=== DEATH ANALYSIS: ' + NUM_GAMES + ' games, up to ' + MAX_ROUNDS + ' rounds ===\n');
console.log('Total deaths: ' + allDeaths.length + '\n');

// Group by cause
var causes = {};
for (var i = 0; i < allDeaths.length; i++) {
    var c = allDeaths[i].cause;
    causes[c] = (causes[c] || 0) + 1;
}
console.log('Deaths by cause:');
for (var c in causes) console.log('  ' + c + ': ' + causes[c]);

// Group by round
var byRound = {};
for (var i = 0; i < allDeaths.length; i++) {
    var r = allDeaths[i].round;
    byRound[r] = (byRound[r] || 0) + 1;
}
console.log('\nDeaths by round:');
for (var r in byRound) console.log('  Round ' + r + ': ' + byRound[r]);

// Show details of each death
console.log('\n=== DEATH DETAILS ===');
for (var i = 0; i < allDeaths.length; i++) {
    var d = allDeaths[i];
    console.log('\nDeath #' + (i+1) + ': Game ' + d.game + ', Round ' + d.round + 
        ', Frame ' + d.frame + ', Cause: ' + d.cause);
    console.log('  Player at (' + d.playerPos + '), jumping=' + d.playerJumping + 
        ', lives left=' + d.livesLeft);
    console.log('  Enemies: ' + d.enemiesAtDeath.map(function(e) { 
        return e.type + '@(' + e.row + ',' + e.col + ')' + (e.jumping ? '[jumping]' : '');
    }).join(', '));
    console.log('  Recent moves:');
    for (var j = 0; j < d.recentMoves.length; j++) {
        var m = d.recentMoves[j];
        console.log('    Move ' + m.move + ': ' + m.dir + ' -> (' + m.pRow + ',' + m.pCol + 
            ')  remaining=' + m.remaining + '  enemies: ' + m.enemies);
    }
}
