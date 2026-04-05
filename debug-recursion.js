#!/usr/bin/env node
var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));
eval(fs.readFileSync('perfect-teacher.js', 'utf8'));

var snap = JSON.parse(fs.readFileSync('/tmp/prev-full.json', 'utf8'));
function mkGs() {
    return { player: JSON.parse(JSON.stringify(snap.player)),
             enemies: JSON.parse(JSON.stringify(snap.enemies)),
             cubes: snap.cubes || [], discs: snap.discs || [],
             sm: snap.sm, tgt: snap.tgt, lv: snap.lv, round: snap.round,
             freezeTimer: snap.freezeTimer || 0,
             cubesColored: 0, score: 0, alive: true, levelWon: false };
}

// Execute STAY one hop, then call teacher on result
console.log('PREV → STAY → CUR:');
var gs1 = mkGs(); gs1.survivalOnly = true;
simHopDecisionQ = [0]; simHopDecisionIdx = 0; // stay is fine with any bit
simRng = function() { return 0.5; };
var alive = simStep(gs1, 'STAY');
console.log('  alive=' + alive);
console.log('  player@(' + gs1.player.row + ',' + gs1.player.col + ')');
console.log('  coily@(' + gs1.enemies.find(function(e){return e.type==="coily";}).row + ',' +
            gs1.enemies.find(function(e){return e.type==="coily";}).col + ')');

// Teacher on resulting state
console.log('\nTeacher on RESULT of STAY:');
perfectTeacherReset();
var r = perfectTeacherEval(gs1, 8, { deadlineMs: Infinity });
for (var dir in r) console.log('  ' + dir + ': P=' + r[dir].toFixed(4));

// ALSO try with bit=1
console.log('\nSTAY with bit=1 (ugg goes up instead of left):');
var gs2 = mkGs(); gs2.survivalOnly = true;
simHopDecisionQ = [1]; simHopDecisionIdx = 0;
simRng = function() { return 0.5; };
simStep(gs2, 'STAY');
console.log('  player@(' + gs2.player.row + ',' + gs2.player.col + ')');
console.log('  coily@(' + gs2.enemies.find(function(e){return e.type==="coily";}).row + ',' +
            gs2.enemies.find(function(e){return e.type==="coily";}).col + ')');
perfectTeacherReset();
var r2 = perfectTeacherEval(gs2, 8, { deadlineMs: Infinity });
for (var dir in r2) console.log('  ' + dir + ': P=' + r2[dir].toFixed(4));
