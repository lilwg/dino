#!/usr/bin/env node
// Reproduce a specific death case and inspect teacher behavior.

var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));
eval(fs.readFileSync('perfect-teacher.js', 'utf8'));

// State: player@(4,1) prev=(3,0) ft=0
//  coily@(2,0)→(3,0)j0.56mt0/11
//  ugg@(5,3)→(5,2)j0.89mt0/9
//  spawn-timers: 2 wrongways (160, 194), 2 redballs (50, 50)
// AI picked DR, validation showed ugg@(5,2) killed.
var sm = 1.5;
var pJumpDur = PLAYER_JUMP_DUR * sm;

function mkGs() {
    return {
        player: {
            row: 4, col: 1, jumping: false, jumpT: 0, jumpDur: pJumpDur,
            dead: false, deathTimer: 0, destRow: null, destCol: null,
            prevRow: 3, prevCol: 0, jumpSrcRow: null, jumpSrcCol: null
        },
        enemies: [
            { type: 'coily', row: 2, col: 0, jumping: true, jumpT: 0.56,
              jumpDur: ENEMY_JUMP_DUR * sm,
              destRow: 3, destCol: 0, jumpSrcRow: 2, jumpSrcCol: 0,
              moveTimer: 0, moveInterval: 11, falling: false, willHatch: false,
              hops: 0, spawnAnimTimer: 0, dirBits: null, lureRow: null, lureCol: null },
            { type: 'ugg', row: 5, col: 3, jumping: true, jumpT: 0.89,
              jumpDur: ENEMY_JUMP_DUR * sm,
              destRow: 5, destCol: 2, jumpSrcRow: 5, jumpSrcCol: 3,
              moveTimer: 0, moveInterval: 9, falling: false, willHatch: false,
              hops: 0, spawnAnimTimer: 0, dirBits: null, lureRow: null, lureCol: null },
            { type: 'spawn-timer', timer: 50, forcedType: 'redball' },
            { type: 'spawn-timer', timer: 50, forcedType: 'redball' },
            { type: 'spawn-timer', timer: 160, forcedType: 'wrongway' },
            { type: 'spawn-timer', timer: 194, forcedType: 'wrongway' }
        ],
        cubes: [], discs: [], sm: sm, tgt: 2, lv: 3, cubesColored: 0,
        score: 0, alive: true, freezeTimer: 0, round: 9, levelWon: false
    };
}

// What does teacher say per dir?
console.log('Teacher prediction (depth 8, worstCaseK=4):');
perfectTeacherReset();
var result = perfectTeacherEval(mkGs(), 8, { worstCaseK: 4, deadlineMs: Infinity });
for (var dir in result) console.log('  ' + dir + ': P=' + result[dir].toFixed(4));

// Now run simStep for DR with many seeds, count deaths
var TARGET_DIR = 'DR';
console.log('\nSim ' + TARGET_DIR + ' with 20 different RNG seeds:');
var deathCount = 0;
for (var s = 0; s < 20; s++) {
    var gs1 = simDeepClone(mkGs());
    gs1.survivalOnly = true;
    simHopDecisionQ = null; simHopDecisionIdx = 0;
    simRng = createSeededRng(s * 1000 + 7);
    var alive = simStep(gs1, TARGET_DIR);
    if (!alive) {
        deathCount++;
        console.log('  seed=' + s + ' DIED — player@(' + gs1.player.row + ',' + gs1.player.col + ') jumpT=' +
                    (gs1.player.jumpT||0).toFixed(2));
        // Find the killer
        for (var ei = 0; ei < gs1.enemies.length; ei++) {
            var e = gs1.enemies[ei];
            if (e.type === 'spawn-timer') continue;
            console.log('    ' + e.type + '@(' + e.row + ',' + e.col + ')' +
                        (e.jumping ? 'j'+(e.jumpT||0).toFixed(2)+'→('+e.destRow+','+e.destCol+')' : ''));
        }
    }
}
console.log('\nTotal deaths: ' + deathCount + '/20');

// Now try the SAME streams the teacher used
console.log('\nTeacher streams (seeds used internally):');
perfectTeacherReset();
var stateSeed = (hashString(teacherStateKey(mkGs())) ^ TARGET_DIR.charCodeAt(0) * 2654435761) | 0;
for (var k = 0; k < 4; k++) {
    var stream = mkStreamCtx(stateSeed ^ 0xC0FFEE ^ (k * 2654435761));
    var gs2 = simDeepClone(mkGs());
    gs2.survivalOnly = true;
    var savedQ = simHopDecisionQ, savedIdx = simHopDecisionIdx, savedRng = simRng;
    simHopDecisionQ = null; simHopDecisionIdx = 0;
    simRng = stream.next;
    var alive2 = simStep(gs2, TARGET_DIR);
    simHopDecisionQ = savedQ; simHopDecisionIdx = savedIdx; simRng = savedRng;
    console.log('  k=' + k + ': UL simStep ' + (alive2 ? 'ALIVE' : 'DEAD'));
}
