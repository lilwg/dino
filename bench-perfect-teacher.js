#!/usr/bin/env node
// Benchmark perfect-teacher on realistic multi-enemy scenarios at varied depths.
// Focus: runtime + memo effectiveness, not correctness.

var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));
eval(fs.readFileSync('perfect-teacher.js', 'utf8'));

var sm = 1.0;
function mkEnemy(type, row, col, moveTimer, dirBits) {
    return {
        type: type, row: row, col: col,
        jumping: false, jumpT: 0, jumpDur: ENEMY_JUMP_DUR * sm,
        destRow: null, destCol: null, jumpSrcRow: null, jumpSrcCol: null,
        moveTimer: moveTimer || 0,
        moveInterval: enemyMoveInterval(type, sm),
        falling: false, willHatch: false, hops: 0, spawnAnimTimer: 0,
        dirBits: dirBits == null ? null : dirBits,
        lureRow: null, lureCol: null
    };
}
function mkGs(pRow, pCol, enemies) {
    return {
        player: { row: pRow, col: pCol, jumping: false, jumpT: 0,
                  jumpDur: PLAYER_JUMP_DUR * sm,
                  dead: false, deathTimer: 0,
                  destRow: null, destCol: null,
                  prevRow: pRow + 1, prevCol: pCol,
                  jumpSrcRow: null, jumpSrcCol: null },
        enemies: enemies, cubes: [], discs: [],
        sm: sm, tgt: 1, lv: 1, cubesColored: 0,
        score: 0, alive: true, freezeTimer: 0, round: 1, levelWon: false
    };
}

var scenarios = [
    { label: '0 enemies', gs: mkGs(4, 2, []) },
    { label: '1 egg',
      gs: mkGs(4, 2, [mkEnemy('egg', 2, 1, 6)]) },
    { label: '1 coily + 1 egg',
      gs: mkGs(4, 2, [mkEnemy('coily', 2, 1, 6), mkEnemy('egg', 3, 0, 3)]) },
    { label: '1 coily + 1 egg + 1 ugg',
      gs: mkGs(4, 2, [mkEnemy('coily', 2, 1, 6),
                       mkEnemy('egg', 3, 0, 3),
                       mkEnemy('ugg', 6, 6, 5)]) },
    { label: '1 coily + 2 eggs + 1 ugg + 1 wrongway',
      gs: mkGs(4, 2, [mkEnemy('coily', 2, 1, 6),
                       mkEnemy('egg', 3, 0, 3),
                       mkEnemy('egg', 2, 2, 7),
                       mkEnemy('ugg', 6, 6, 5),
                       mkEnemy('wrongway', 6, 0, 2)]) },
    { label: '1 ball (dirBits=42) + 1 egg',
      gs: mkGs(4, 2, [mkEnemy('redball', 2, 1, 6, 42),
                       mkEnemy('egg', 3, 3, 4)]) },
    { label: 'player surrounded (adversarial)',
      gs: mkGs(4, 2, [mkEnemy('egg', 3, 1, 11),
                       mkEnemy('egg', 3, 2, 11),
                       mkEnemy('egg', 5, 2, 11),
                       mkEnemy('egg', 5, 3, 11)]) },
    { label: 'spawn in horizon (spawn-timer)',
      gs: (function() {
          var gs = mkGs(4, 2, [mkEnemy('egg', 2, 1, 6)]);
          gs.enemies.push({ type: 'spawn-timer', timer: 30, forcedType: 'redball' });
          return gs;
      })() },
];

// MC sample sweep (fixed depth=8) on spawn-in-horizon scenario
console.log('── mcSamples sweep (depth=8, spawn-in-horizon) ──');
var spawnScenario = scenarios[scenarios.length - 1];
[8, 16, 32, 64, 128, 256, 512, 1024].forEach(function(mc) {
    perfectTeacherReset();
    var t0 = Date.now();
    perfectTeacherEval(spawnScenario.gs, 8, { mcSamples: mc });
    var ms = Date.now() - t0;
    var s = perfectTeacherStats();
    console.log('  mc=' + mc + ': ' + ms + 'ms  simSteps=' + s.simStepCalls +
                ' mcNodes=' + s.mcNodes + ' memo=' + s.memoSize);
});

console.log('\ndepth | scenario                             |    ms | simSteps | memo hits | memo size');
console.log('------|--------------------------------------|-------|----------|-----------|----------');
for (var d = 4; d <= 12; d += 2) {
    for (var si = 0; si < scenarios.length; si++) {
        perfectTeacherReset();
        var t0 = Date.now();
        perfectTeacherEval(scenarios[si].gs, d, { mcSamples: 128 });
        var ms = Date.now() - t0;
        var s = perfectTeacherStats();
        var lbl = scenarios[si].label.padEnd(38);
        console.log('  ' + d.toString().padStart(3) + ' | ' + lbl + ' | ' +
                    ms.toString().padStart(5) + ' | ' +
                    s.simStepCalls.toString().padStart(8) + ' | ' +
                    s.memoHits.toString().padStart(9) + ' | ' +
                    s.memoSize.toString().padStart(9));
    }
    console.log('------|--------------------------------------|-------|----------|-----------|----------');
}
