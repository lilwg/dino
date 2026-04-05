#!/usr/bin/env node
// Reproduce a DOOM-ENTRY state and compare teacher's prediction to actual
// outcomes. Traces forward: which paths actually survive 2-3 hops?

var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));
eval(fs.readFileSync('perfect-teacher.js', 'utf8'));

// DOOM-ENTRY 1: player@(5,1), chose UL, next state doomed
var snap = {"player":{"row":5,"col":1,"prevRow":4,"prevCol":1,"dead":false,"deathTimer":0,"jumping":false,"jumpT":1,"jumpDur":0.03428571428571428,"jumpSrcRow":4,"jumpSrcCol":1,"destRow":null,"destCol":null},"enemies":[{"type":"spawn-timer","timer":90,"forcedType":"slick"},{"type":"coily","row":3,"col":1,"jumping":true,"jumpT":0.2,"jumpDur":0.04,"destRow":4,"destCol":1,"jumpSrcRow":3,"jumpSrcCol":1,"moveTimer":0,"moveInterval":13,"falling":false,"willHatch":false,"hops":5,"spawnAnimTimer":0},{"type":"ugg","row":5,"col":3,"jumping":true,"jumpT":0.64,"jumpDur":0.04,"destRow":4,"destCol":2,"jumpSrcRow":5,"jumpSrcCol":3,"moveTimer":0,"moveInterval":10,"falling":false,"willHatch":false,"hops":0,"spawnAnimTimer":0},{"type":"redball","row":2,"col":1,"jumping":true,"jumpT":0.88,"jumpDur":0.04,"destRow":3,"destCol":2,"jumpSrcRow":2,"jumpSrcCol":1,"moveTimer":0,"moveInterval":10,"falling":false,"willHatch":false,"hops":0,"spawnAnimTimer":0,"dirBits":31},{"type":"spawn-timer","timer":499,"forcedType":"greenball"},{"type":"wrongway","row":6,"col":0,"jumping":true,"jumpT":0.04,"jumpDur":0.04,"destRow":5,"destCol":0,"jumpSrcRow":6,"jumpSrcCol":0,"moveTimer":0,"moveInterval":10,"falling":false,"willHatch":false,"hops":0,"spawnAnimTimer":0}],"sm":1.2,"tgt":2,"lv":2,"round":7,"freezeTimer":0,"dir":"UL","survP":{"UL":1,"UR":0,"DL":1,"DR":1,"STAY":1}};

function mkGs() {
    return {
        player: JSON.parse(JSON.stringify(snap.player)),
        enemies: JSON.parse(JSON.stringify(snap.enemies)),
        sm: snap.sm, tgt: snap.tgt, lv: snap.lv, round: snap.round,
        freezeTimer: snap.freezeTimer,
        cubes: [], discs: [],
        cubesColored: 0, score: 0, alive: true, levelWon: false
    };
}

console.log('Reported survP:', snap.survP, '| chose:', snap.dir);

console.log('\nTeacher @ K=16:');
perfectTeacherReset();
var result = perfectTeacherEval(mkGs(), 8, { worstCaseK: 16, deadlineMs: Infinity });
for (var dir in result) console.log('  ' + dir + ': P=' + result[dir].toFixed(4));

console.log('\nTeacher @ K=64:');
perfectTeacherReset();
var result2 = perfectTeacherEval(mkGs(), 8, { worstCaseK: 64, deadlineMs: Infinity });
for (var dir in result2) console.log('  ' + dir + ': P=' + result2[dir].toFixed(4));

// For each dir, try 40 simStep seeds and count survivals (1 hop)
console.log('\n1-hop simStep survivals (40 seeds each):');
['UL','UR','DL','DR','STAY'].forEach(function(dir) {
    var d = dir === 'STAY' ? {dr:0,dc:0} : DIRS[dir];
    if (dir !== 'STAY' && !isValidPos(snap.player.row + d.dr, snap.player.col + d.dc)) { console.log('  ' + dir + ': off-grid'); return; }
    var lives = 0;
    for (var s = 0; s < 40; s++) {
        var gs1 = mkGs(); gs1.survivalOnly = true;
        simHopDecisionQ = null; simHopDecisionIdx = 0;
        simRng = createSeededRng(s * 100 + 7);
        if (simStep(gs1, dir)) lives++;
    }
    console.log('  ' + dir + ': ' + lives + '/40 survived 1 hop');
});

// Deeper probe: for UL (which AI chose), run simStep then try 2nd-hop survival across seeds
console.log('\n2-hop simStep survivals after UL (500 seeds):');
var doomCount = 0;
for (var s = 0; s < 500; s++) {
    var gs1 = mkGs(); gs1.survivalOnly = true;
    simHopDecisionQ = null; simHopDecisionIdx = 0;
    simRng = createSeededRng(s * 100 + 7);
    var alive1 = simStep(gs1, 'UL');
    if (!alive1) continue;
    // Now check 2nd hop under same RNG continuation
    var anySafe = false;
    for (var dk = 0; dk < 5; dk++) {
        var dir2 = ['UL','UR','DL','DR','STAY'][dk];
        var d2 = dir2 === 'STAY' ? {dr:0,dc:0} : DIRS[dir2];
        if (dir2 !== 'STAY' && !isValidPos(gs1.player.row + d2.dr, gs1.player.col + d2.dc)) continue;
        var gs2 = simDeepClone(gs1); gs2.survivalOnly = true;
        var sav = simRng;
        if (simStep(gs2, dir2)) { anySafe = true; break; }
        simRng = sav;
    }
    if (!anySafe) { doomCount++; if (doomCount <= 5) console.log('  seed=' + s + ': UL→@(' + gs1.player.row + ',' + gs1.player.col + ') DOOMED (no safe 2nd hop)'); }
}
console.log('  total doom: ' + doomCount + '/500');

// Advance one step with a couple specific seeds, then call teacher on result
console.log('\nAfter UL (seed=42): teacher on resulting state');
var gs1 = mkGs(); gs1.survivalOnly = false;
simHopDecisionQ = null; simHopDecisionIdx = 0;
simRng = createSeededRng(42 * 100 + 7);
var alive = simStep(gs1, 'UL');
console.log('  player@(' + gs1.player.row + ',' + gs1.player.col + ') alive=' + alive);
for (var ei = 0; ei < gs1.enemies.length; ei++) {
    var e = gs1.enemies[ei];
    if (e.type === 'spawn-timer') console.log('    ST ' + e.timer + ':' + e.forcedType);
    else console.log('    ' + e.type + '@(' + e.row + ',' + e.col + ')' +
        (e.jumping?'j'+e.jumpT.toFixed(2)+'→('+e.destRow+','+e.destCol+')':'t'+(e.moveTimer||0)));
}
perfectTeacherReset();
var result3 = perfectTeacherEval(gs1, 8, { worstCaseK: 16, deadlineMs: Infinity });
console.log('  teacher next:');
for (var dir in result3) console.log('    ' + dir + ': P=' + result3[dir].toFixed(4));
