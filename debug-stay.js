#!/usr/bin/env node
var fs = require('fs');
eval(fs.readFileSync('qbert.js', 'utf8'));
eval(fs.readFileSync('qbert-ai.js', 'utf8'));

var snap = JSON.parse(fs.readFileSync('/tmp/prev-full.json', 'utf8'));
var gs = { player: JSON.parse(JSON.stringify(snap.player)),
           enemies: JSON.parse(JSON.stringify(snap.enemies)),
           cubes: snap.cubes || [], discs: snap.discs || [],
           sm: snap.sm, tgt: snap.tgt, lv: snap.lv, round: snap.round,
           freezeTimer: snap.freezeTimer || 0,
           cubesColored: 0, score: 0, alive: true, levelWon: false };
gs.survivalOnly = false;

console.log('BEFORE STAY:');
gs.enemies.forEach(function(e) {
    if (e.type === 'spawn-timer') return;
    console.log('  ' + e.type + '@(' + e.row + ',' + e.col + ') mt=' + (e.moveTimer||0) + ' j=' + e.jumping + (e.jumping?'jT='+e.jumpT.toFixed(2):''));
});

simHopDecisionQ = null; simHopDecisionIdx = 0;
simRng = function() { return 0.5; };
simStep(gs, 'STAY');

console.log('AFTER STAY:');
gs.enemies.forEach(function(e) {
    if (e.type === 'spawn-timer') return;
    console.log('  ' + e.type + '@(' + e.row + ',' + e.col + ') mt=' + (e.moveTimer||0) + ' j=' + e.jumping + (e.jumping?' jT='+e.jumpT.toFixed(2):''));
});
