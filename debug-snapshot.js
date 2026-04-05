#!/usr/bin/env node
var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));
eval(fs.readFileSync('perfect-teacher.js', 'utf8'));

// Exact snapshot from PRED-FAIL
var snap = {"player":{"row":5,"col":2,"prevRow":4,"prevCol":2,"dead":false,"deathTimer":0,"jumping":false,"jumpT":1,"jumpDur":0.039999999999999994,"jumpSrcRow":4,"jumpSrcCol":2,"destRow":null,"destCol":null},"enemies":[{"type":"coily","row":5,"col":3,"jumping":false,"jumpT":1,"jumpDur":0.04666666666666666,"destRow":null,"destCol":null,"jumpSrcRow":6,"jumpSrcCol":3,"moveTimer":1,"moveInterval":11,"falling":false,"willHatch":false,"hops":5,"spawnAnimTimer":0},{"type":"redball","row":4,"col":3,"jumping":true,"jumpT":0.3733333333333333,"jumpDur":0.04666666666666666,"destRow":5,"destCol":4,"jumpSrcRow":4,"jumpSrcCol":3,"moveTimer":0,"moveInterval":9,"falling":false,"willHatch":false,"hops":0,"spawnAnimTimer":0,"dirBits":4},{"type":"redball","row":1,"col":0,"jumping":true,"jumpT":0.7466666666666664,"jumpDur":0.04666666666666666,"destRow":2,"destCol":1,"jumpSrcRow":1,"jumpSrcCol":0,"moveTimer":0,"moveInterval":9,"falling":false,"willHatch":false,"hops":0,"spawnAnimTimer":0,"dirBits":55}],"sm":1.4,"tgt":1,"lv":3,"round":9,"freezeTimer":0,"dir":"UR","teacherP":1};

function mkGs() {
    var gs = {
        player: JSON.parse(JSON.stringify(snap.player)),
        enemies: JSON.parse(JSON.stringify(snap.enemies)),
        sm: snap.sm, tgt: snap.tgt, lv: snap.lv, round: snap.round,
        freezeTimer: snap.freezeTimer,
        cubes: [], discs: [],
        cubesColored: 0, score: 0, alive: true, levelWon: false
    };
    return gs;
}

console.log('State: player@(' + snap.player.row + ',' + snap.player.col + ') prev=(' +
            snap.player.prevRow + ',' + snap.player.prevCol + ')');
console.log('Game reported teacherP[' + snap.dir + '] = ' + snap.teacherP);

console.log('\nTeacher (depth 8, worstCaseK=4, deadline=Inf):');
perfectTeacherReset();
var result = perfectTeacherEval(mkGs(), 8, { worstCaseK: 4, deadlineMs: Infinity });
for (var dir in result) console.log('  ' + dir + ': P=' + result[dir].toFixed(4));
console.log('  (reachedDepth=' + perfectTeacherStats().maxDepthSeen + ')');

console.log('\nTeacher (depth 8, worstCaseK=4, deadline=50ms — game config):');
perfectTeacherReset();
var result2 = perfectTeacherEval(mkGs(), 8, { worstCaseK: 4, deadlineMs: 50 });
for (var dir in result2) console.log('  ' + dir + ': P=' + result2[dir].toFixed(4));
console.log('  (reachedDepth=' + perfectTeacherStats().maxDepthSeen + ')');

console.log('\nSim UR with 10 seeds, 1 hop:');
for (var s = 0; s < 10; s++) {
    var gs1 = mkGs();
    gs1.survivalOnly = true;
    simHopDecisionQ = null; simHopDecisionIdx = 0;
    simRng = createSeededRng(s * 1000 + 7);
    var alive = simStep(gs1, 'UR');
    console.log('  seed=' + s + ': ' + (alive ? 'alive' : 'DEAD'));
}

// Try UR then random greedy for 7 more hops
console.log('\nUR + best-of-4-dirs greedy for 7 more hops (seed=0):');
var gs2 = mkGs();
gs2.survivalOnly = true;
simHopDecisionQ = null; simHopDecisionIdx = 0;
simRng = createSeededRng(7);
var alive = simStep(gs2, 'UR');
console.log('  after UR: ' + (alive ? 'alive @(' + gs2.player.row + ',' + gs2.player.col + ')' : 'DEAD'));
function enemyStr(gs) { var s = ''; for (var i = 0; i < gs.enemies.length; i++) { var e = gs.enemies[i]; if (e.type === 'spawn-timer') continue; s += ' ' + e.type + '@(' + e.row + ',' + e.col + ')' + (e.jumping?'j'+e.jumpT.toFixed(2)+'→('+e.destRow+','+e.destCol+')':'t'+(e.moveTimer||0)); } return s; }
console.log('    enemies:' + enemyStr(gs2));
for (var hop = 0; hop < 7 && alive; hop++) {
    // Try each dir, pick first that survives
    var found = null;
    for (var dk = 0; dk < 4; dk++) {
        var dir = ['UL','UR','DL','DR'][dk];
        var d = DIRS[dir];
        if (!isValidPos(gs2.player.row + d.dr, gs2.player.col + d.dc)) continue;
        var gs3 = simDeepClone(gs2);
        gs3.survivalOnly = true;
        simHopDecisionQ = null; simHopDecisionIdx = 0;
        var sav = simRng; simRng = createSeededRng(hop * 100 + 7);
        var a = simStep(gs3, dir);
        simRng = sav;
        if (a) { found = dir; break; }
    }
    if (!found) {
        console.log('  hop=' + hop + ': NO SAFE DIR — player@(' + gs2.player.row + ',' + gs2.player.col + ')');
        console.log('    enemies:' + enemyStr(gs2));
        // Show why each dir fails
        for (var dk = 0; dk < 4; dk++) {
            var dir = ['UL','UR','DL','DR'][dk];
            var d = DIRS[dir];
            if (!isValidPos(gs2.player.row + d.dr, gs2.player.col + d.dc)) { console.log('    ' + dir + ': off-grid'); continue; }
            var gs3 = simDeepClone(gs2);
            gs3.survivalOnly = true;
            simHopDecisionQ = null; simHopDecisionIdx = 0;
            simRng = createSeededRng(hop * 100 + 7);
            var a = simStep(gs3, dir);
            console.log('    ' + dir + ': ' + (a ? 'alive' : 'DEAD') + ' → @(' + gs3.player.row + ',' + gs3.player.col + ')' + (a ? '' : ' killed by enemies:' + enemyStr(gs3)));
        }
        alive = false; break;
    }
    simHopDecisionQ = null; simHopDecisionIdx = 0;
    alive = simStep(gs2, found);
    console.log('  hop=' + hop + ': ' + found + ' → ' + (alive ? '@(' + gs2.player.row + ',' + gs2.player.col + ')' : 'DEAD'));
}
