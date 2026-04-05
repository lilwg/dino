#!/usr/bin/env node
var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));
eval(fs.readFileSync('perfect-teacher.js', 'utf8'));

// DOOM-ENTRY prev state
var prev = {"player":{"row":1,"col":0,"prevRow":1,"prevCol":0,"dead":false,"deathTimer":0,"jumping":false,"jumpT":1,"jumpDur":0.02857142857142857,"jumpSrcRow":2,"jumpSrcCol":1,"destRow":null,"destCol":null},"enemies":[{"type":"coily","row":3,"col":2,"jumping":true,"jumpT":0.5666666666666667,"jumpDur":0.03333333333333333,"destRow":2,"destCol":1,"jumpSrcRow":3,"jumpSrcCol":2,"moveTimer":0,"moveInterval":16,"falling":false,"willHatch":false,"hops":5,"spawnAnimTimer":0},{"type":"spawn-timer","timer":93,"forcedType":"slick"},{"type":"ugg","row":3,"col":2,"jumping":false,"jumpT":1,"jumpDur":0.03333333333333333,"destRow":null,"destCol":null,"jumpSrcRow":4,"jumpSrcCol":3,"moveTimer":5,"moveInterval":12,"falling":false,"willHatch":false,"hops":0,"spawnAnimTimer":0},{"type":"spawn-timer","timer":45,"forcedType":"redball"},{"type":"wrongway","row":6,"col":0,"jumping":false,"jumpT":0,"jumpDur":0.03333333333333333,"destRow":null,"destCol":null,"moveTimer":0,"moveInterval":12,"falling":false,"willHatch":false,"hops":0,"spawnAnimTimer":3}]};

var cur = {"player":{"row":2,"col":0,"prevRow":1,"prevCol":0,"dead":false,"deathTimer":0,"jumping":false,"jumpT":1,"jumpDur":0.02857142857142857,"jumpSrcRow":1,"jumpSrcCol":0,"destRow":null,"destCol":null},"enemies":[{"type":"coily","row":2,"col":1,"jumping":true,"jumpT":0.16666666666666666,"jumpDur":0.03333333333333333,"destRow":1,"destCol":0,"jumpSrcRow":2,"jumpSrcCol":1,"moveTimer":0,"moveInterval":16,"falling":false,"willHatch":false,"hops":5,"spawnAnimTimer":0},{"type":"spawn-timer","timer":58,"forcedType":"slick"},{"type":"ugg","row":3,"col":2,"jumping":true,"jumpT":0.9333333333333332,"jumpDur":0.03333333333333333,"destRow":3,"destCol":1,"jumpSrcRow":3,"jumpSrcCol":2,"moveTimer":0,"moveInterval":12,"falling":false,"willHatch":false,"hops":0,"spawnAnimTimer":0},{"type":"spawn-timer","timer":10,"forcedType":"redball"},{"type":"wrongway","row":6,"col":0,"jumping":true,"jumpT":0.6666666666666666,"jumpDur":0.03333333333333333,"destRow":5,"destCol":0,"jumpSrcRow":6,"jumpSrcCol":0,"moveTimer":0,"moveInterval":12,"falling":false,"willHatch":false,"hops":0,"spawnAnimTimer":0}]};

function mkGs(src) {
    return { player: JSON.parse(JSON.stringify(src.player)),
             enemies: JSON.parse(JSON.stringify(src.enemies)),
             sm: 1, tgt: 1, lv: 1, round: 4, freezeTimer: 0,
             cubes: [], discs: [], cubesColored: 0, score: 0, alive: true, levelWon: false };
}

console.log('Teacher on PREV (before DL):');
perfectTeacherReset();
var r1 = perfectTeacherEval(mkGs({player:prev.player,enemies:prev.enemies}), 8, { worstCaseK: 16, deadlineMs: Infinity });
for (var dir in r1) console.log('  ' + dir + ': P=' + r1[dir].toFixed(4));

console.log('\nTeacher on CUR (after DL landed):');
perfectTeacherReset();
var r2 = perfectTeacherEval(mkGs({player:cur.player,enemies:cur.enemies}), 8, { worstCaseK: 16, deadlineMs: Infinity });
for (var dir in r2) console.log('  ' + dir + ': P=' + r2[dir].toFixed(4));

// Sim DL from prev, many seeds
console.log('\nsimStep DL from prev with 100 seeds, track landing state:');
var doomCount = 0;
for (var s = 0; s < 100; s++) {
    var gs1 = mkGs({player:prev.player,enemies:prev.enemies}); gs1.survivalOnly = true;
    simHopDecisionQ = null; simHopDecisionIdx = 0;
    simRng = createSeededRng(s * 100 + 7);
    var alive = simStep(gs1, 'DL');
    if (!alive) continue;
    // Check all 2nd dirs
    var anySafe = false;
    for (var dk = 0; dk < 5; dk++) {
        var dir2 = ['UL','UR','DL','DR','STAY'][dk];
        var d2 = dir2 === 'STAY' ? {dr:0,dc:0} : DIRS[dir2];
        if (dir2 !== 'STAY' && !isValidPos(gs1.player.row + d2.dr, gs1.player.col + d2.dc)) continue;
        var gs2 = simDeepClone(gs1); gs2.survivalOnly = true;
        if (simStep(gs2, dir2)) { anySafe = true; break; }
    }
    if (!anySafe) doomCount++;
}
console.log('  doom: ' + doomCount + '/100');

// Direct check: run simStep with a specific seed + trace
console.log('\nCompare: sim DL from prev with seed=0, check landing state enemies');
var gs1 = mkGs({player:prev.player,enemies:prev.enemies}); gs1.survivalOnly = true;
simHopDecisionQ = null; simHopDecisionIdx = 0;
simRng = createSeededRng(0 * 100 + 7);
simStep(gs1, 'DL');
console.log('  landing state:');
console.log('    player@(' + gs1.player.row + ',' + gs1.player.col + ') prev=(' + gs1.player.prevRow + ',' + gs1.player.prevCol + ')');
for (var ei = 0; ei < gs1.enemies.length; ei++) {
    var e = gs1.enemies[ei];
    if (e.type === 'spawn-timer') console.log('    ST ' + e.timer + ':' + e.forcedType);
    else console.log('    ' + e.type + '@(' + e.row + ',' + e.col + ')' +
        (e.jumping?'j'+e.jumpT.toFixed(2)+'→('+e.destRow+','+e.destCol+')':'t'+(e.moveTimer||0)));
}

console.log('\nDifferences cur-vs-simLanded:');
console.log('  player @(' + cur.player.row + ',' + cur.player.col + ') vs @(' + gs1.player.row + ',' + gs1.player.col + ')');
console.log('  # enemies: ' + cur.enemies.length + ' vs ' + gs1.enemies.length);
for (var ei = 0; ei < Math.max(cur.enemies.length, gs1.enemies.length); ei++) {
    var c = cur.enemies[ei], s = gs1.enemies[ei];
    var cj = JSON.stringify(c), sj = JSON.stringify(s);
    if (cj === sj) console.log('  [' + ei + '] MATCH');
    else { console.log('  [' + ei + '] cur=' + cj); console.log('          sim=' + sj); }
}
