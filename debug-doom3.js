#!/usr/bin/env node
var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));
eval(fs.readFileSync('perfect-teacher.js', 'utf8'));

// DOOM 3: prev player@(5,0), game reported UR=1, DL=0, DR=0, STAY=1, chose UR
// enemies: coily@(5,2)j0.80→(6,2), ugg@(3,1)t3, redball@(1,1)j0.60→(2,2)dirBits=52, wrongway@(6,0)sa2
var prev = {"player":{"row":5,"col":0,"prevRow":5,"prevCol":0,"dead":false,"deathTimer":0,"jumping":false,"jumpT":1,"jumpDur":0.03428571428571428,"jumpSrcRow":6,"jumpSrcCol":1,"destRow":null,"destCol":null},"enemies":[{"type":"coily","row":5,"col":2,"jumping":true,"jumpT":0.8000000000000002,"jumpDur":0.04,"destRow":6,"destCol":2,"jumpSrcRow":5,"jumpSrcCol":2,"moveTimer":0,"moveInterval":13,"falling":false,"willHatch":false,"hops":5,"spawnAnimTimer":0},{"type":"ugg","row":3,"col":1,"jumping":false,"jumpT":1,"jumpDur":0.04,"destRow":null,"destCol":null,"jumpSrcRow":3,"jumpSrcCol":2,"moveTimer":3,"moveInterval":10,"falling":false,"willHatch":false,"hops":0,"spawnAnimTimer":0},{"type":"redball","row":1,"col":1,"jumping":true,"jumpT":0.6,"jumpDur":0.04,"destRow":2,"destCol":2,"jumpSrcRow":1,"jumpSrcCol":1,"moveTimer":0,"moveInterval":10,"falling":false,"willHatch":false,"hops":0,"spawnAnimTimer":0,"dirBits":52},{"type":"wrongway","row":6,"col":0,"jumping":false,"jumpT":0,"jumpDur":0.04,"destRow":null,"destCol":null,"moveTimer":0,"moveInterval":10,"falling":false,"willHatch":false,"hops":0,"spawnAnimTimer":2}]};

function mkGs(src) {
    return { player: JSON.parse(JSON.stringify(src.player)),
             enemies: JSON.parse(JSON.stringify(src.enemies)),
             sm: 1.2, tgt: 2, lv: 2, round: 5, freezeTimer: 0,
             cubes: [], discs: [], cubesColored: 0, score: 0, alive: true, levelWon: false };
}

console.log('Measuring branching for UR from prev:');
var b = teacherMeasureBranching(mkGs(prev), 'UR');
console.log('  hopBits=' + b.hopBits + ' rngCalls=' + b.rngCalls);

console.log('\nTeacher PREV (expect UR=1 DL=0 DR=0 STAY=1):');
perfectTeacherReset();
var r1 = perfectTeacherEval(mkGs(prev), 8, { deadlineMs: Infinity });
for (var dir in r1) console.log('  ' + dir + ': P=' + r1[dir].toFixed(4));

// Advance UR many seeds, check next state
console.log('\nsimStep UR from prev, 20 seeds, check next-hop survivable:');
var doom = 0;
for (var s = 0; s < 500; s++) {
    var gs1 = mkGs(prev); gs1.survivalOnly = true;
    simHopDecisionQ = null; simHopDecisionIdx = 0;
    simRng = createSeededRng(s * 100 + 7);
    var alive = simStep(gs1, 'UR');
    if (!alive) { console.log('  s=' + s + ' UR died immediately'); continue; }
    perfectTeacherReset();
    var r2 = perfectTeacherEval(gs1, 8, { deadlineMs: Infinity });
    var safe = false, ps = '';
    for (var dir in r2) { ps += ' ' + dir + '=' + r2[dir].toFixed(2); if (r2[dir] > 0) safe = true; }
    if (!safe) doom++;
    if (!safe) console.log('  s=' + s + ': @(' + gs1.player.row + ',' + gs1.player.col + ') P=[' + ps.trim() + ']' + (safe?'':' DOOM'));
}
console.log('doom: ' + doom + '/500');

// Run teacher's OWN simulation of UR from prev, using hop-bit enumeration.
// Take specific hop-bit combo and trace.
console.log('\nTeacher-style enumeration: UR with all hop-bit combos, simRng=0.5:');
for (var c = 0; c < 4; c++) {
    var gs1 = mkGs(prev); gs1.survivalOnly = true;
    simHopDecisionQ = [c & 1, (c >> 1) & 1]; simHopDecisionIdx = 0;
    simRng = function() { return 0.5; };
    var alive = simStep(gs1, 'UR');
    console.log('  combo=' + c + ': ' + (alive?'@(' + gs1.player.row + ',' + gs1.player.col + ')':'DEAD'));
    if (alive) {
        perfectTeacherReset();
        var r = perfectTeacherEval(gs1, 8, { deadlineMs: Infinity });
        var ps = '';
        for (var dir in r) ps += ' ' + dir + '=' + r[dir].toFixed(2);
        console.log('    teacher next P=[' + ps.trim() + ']');
    }
}
