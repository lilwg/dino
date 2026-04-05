#!/usr/bin/env node
// Replay a DOOM-ENTRY snapshot (from JSON on stdin or file arg)
// Usage: node debug-replay.js <snap-file-or-">">

var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));
eval(fs.readFileSync('perfect-teacher.js', 'utf8'));

var input;
if (process.argv[2]) input = fs.readFileSync(process.argv[2], 'utf8').trim();
else input = fs.readFileSync(0, 'utf8').trim();
var snap = JSON.parse(input);

function mkGs() {
    return {
        player: JSON.parse(JSON.stringify(snap.player)),
        enemies: JSON.parse(JSON.stringify(snap.enemies)),
        cubes: snap.cubes || [],
        discs: snap.discs || [],
        sm: snap.sm, tgt: snap.tgt, lv: snap.lv, round: snap.round,
        freezeTimer: snap.freezeTimer || 0,
        cubesColored: 0, score: 0, alive: true, levelWon: false
    };
}

console.log('State: player@(' + snap.player.row + ',' + snap.player.col + ') prev=(' +
            snap.player.prevRow + ',' + snap.player.prevCol + ')');
console.log('  sm=' + snap.sm + ' lv=' + snap.lv + ' round=' + snap.round);
console.log('  enemies: ' + snap.enemies.filter(function(e) { return e.type !== 'spawn-timer'; }).length +
            ' + ' + snap.enemies.filter(function(e) { return e.type === 'spawn-timer'; }).length + ' spawn-timers');
console.log('  discs: ' + (snap.discs || []).length);
console.log('  game dir=' + snap.dir + ' survP=' + JSON.stringify(snap.survP));

// Measure branching factor with different bit arrays
console.log('\nBranching factor:');
['UL','UR','DL','DR','STAY'].forEach(function(dir) {
    if (dir !== 'STAY') {
        var d = DIRS[dir];
        if (!isValidPos(snap.player.row + d.dr, snap.player.col + d.dc)) { console.log('  ' + dir + ': off-grid'); return; }
    }
    // Measure with all-0s
    var counts = [];
    for (var trial = 0; trial < 4; trial++) {
        var bits = new Array(64); for (var i = 0; i < 64; i++) bits[i] = (trial >> i) & 1;
        var gs1 = simDeepClone(mkGs()); gs1.survivalOnly = true;
        simHopDecisionQ = bits; simHopDecisionIdx = 0;
        simRng = function() { return 0.5; };
        simStep(gs1, dir);
        counts.push(simHopDecisionIdx);
    }
    console.log('  ' + dir + ': bits consumed for trials 0..3: [' + counts.join(',') + ']');
});

console.log('\nTeacher:');
perfectTeacherReset();
var r = perfectTeacherEval(mkGs(), 8, { deadlineMs: Infinity });
for (var dir in r) console.log('  ' + dir + ': P=' + r[dir].toFixed(4));

// Run 100 RNG seeds forward 2 hops, count doom
console.log('\nForward sim (500 seeds) from chosen dir, check TEACHER on landing state:');
var teacherDoom = 0;
for (var s = 0; s < 500; s++) {
    var gs1 = mkGs(); gs1.survivalOnly = true;
    simHopDecisionQ = null; simHopDecisionIdx = 0;
    simRng = createSeededRng(s * 100 + 7);
    var alive = simStep(gs1, snap.dir);
    if (!alive) continue;
    // Call teacher on landing state
    perfectTeacherReset();
    var r2 = perfectTeacherEval(gs1, 8, { deadlineMs: Infinity });
    var anySafe = false;
    for (var d2k in r2) if (r2[d2k] > 0) { anySafe = true; break; }
    if (!anySafe) { teacherDoom++; if (teacherDoom <= 3) console.log('  s=' + s + ': DOOM teacher says all 0 from @(' + gs1.player.row + ',' + gs1.player.col + ')'); }
}
console.log('  landing state DOOM: ' + teacherDoom + '/500');
