#!/usr/bin/env node
'use strict';
var sim = require('./train-cmaes.js');

// Debug: trace the first collision
var game = sim.createGame();
var prevObs = null;
for (var f = 0; f < 5000; f++) {
    var state = sim.extractState(game);
    // Jump when obstacle is close
    var a = 0;
    if (state[0] < 0.3 && !game.tRex.jumping) a = 1;

    // Log obstacle info every few frames
    if (game.obstacles.length > 0 && f % 10 === 0) {
        var obs = game.obstacles[0];
        var dist = obs.xPos - game.tRex.xPos;
        if (dist < 200 && dist > -50) {
            console.log('f=' + f + ' | obs.x=' + Math.round(obs.xPos) + ' dist=' + Math.round(dist) +
                ' obs.type=' + obs.typeConfig.type + ' obs.y=' + obs.yPos + ' obs.h=' + obs.typeConfig.height +
                ' | trex.y=' + Math.round(game.tRex.yPos) + ' jumping=' + game.tRex.jumping +
                ' ducking=' + game.tRex.ducking + ' action=' + a +
                ' speed=' + game.currentSpeed.toFixed(2));
        }
    }

    var col = sim.gameStep(game, a);
    if (col) {
        var obs = game.obstacles[0];
        console.log('\nCOLLISION at frame ' + f + '!');
        console.log('  trex: x=' + game.tRex.xPos + ' y=' + Math.round(game.tRex.yPos) +
            ' jumping=' + game.tRex.jumping + ' ducking=' + game.tRex.ducking);
        console.log('  obs: x=' + Math.round(obs.xPos) + ' y=' + obs.yPos +
            ' w=' + obs.width + ' h=' + obs.typeConfig.height +
            ' type=' + obs.typeConfig.type + ' size=' + obs.size);
        console.log('  score:', Math.round(game.distanceRan * 0.025));
        break;
    }
}
