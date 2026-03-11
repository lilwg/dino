#!/usr/bin/env node
'use strict';
var sim = require('./train-cmaes.js');

// Test 1: always-run
var game = sim.createGame();
var frames;
for (frames = 0; frames < 30000; frames++) {
    if (sim.gameStep(game, 0)) break;
}
console.log('Always-run: died at frame', frames, 'score', Math.round(game.distanceRan * 0.025));

// Test 2: always-jump
game = sim.createGame();
for (frames = 0; frames < 30000; frames++) {
    var action = game.tRex.jumping ? 0 : 1;
    if (sim.gameStep(game, action)) break;
}
console.log('Always-jump: died at frame', frames, 'score', Math.round(game.distanceRan * 0.025));

// Test 3: smart jump
console.log('\n5 runs of smart-jump (jump when obs < 0.25):');
for (var r = 0; r < 5; r++) {
    game = sim.createGame();
    for (frames = 0; frames < 30000; frames++) {
        var state = sim.extractState(game);
        var a = 0;
        if (state[0] < 0.25 && !game.tRex.jumping) a = 1;
        if (sim.gameStep(game, a)) break;
    }
    console.log('  Run', r, ': score', Math.round(game.distanceRan * 0.025), 'frames', frames);
}

// Test 4: smart jump + duck for pteros
console.log('\n5 runs of smart-jump+duck:');
for (var r = 0; r < 5; r++) {
    game = sim.createGame();
    for (frames = 0; frames < 30000; frames++) {
        var state = sim.extractState(game);
        var a = 0;
        if (state[0] < 0.25 && !game.tRex.jumping) {
            if (state[2] === 1 && state[1] > 0.6) a = 2; // duck for high ptero
            else a = 1;
        }
        if (sim.gameStep(game, a)) break;
    }
    console.log('  Run', r, ': score', Math.round(game.distanceRan * 0.025), 'frames', frames);
}
