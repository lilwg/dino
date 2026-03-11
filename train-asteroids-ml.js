#!/usr/bin/env node
// Headless training for DinoAsteroids imitation learning
// Extracts game physics + rule AI, runs data collection + training in pure Node.js
// Outputs trained weights as JSON to paste into the HTML

'use strict';

// ─── Game constants ─────────────────────────────────────────────────────────
var CW = 600, CH = 400;
var SHIP_R = 10, TURN = 0.065, ACCEL = 0.15, FRIC = 0.987, VMAX = 6;
var B_SPD = 7, B_LIFE = 58, UFO_INT = 1500;
var RADII  = [0, 11, 20, 38];
var SPEEDS = [0, 1.8, 1.1, 0.6];
var APTS   = [0, 100, 50, 20];
var DODGE_HARD = 75, DODGE_SOFT = 130;

// ─── Game state ─────────────────────────────────────────────────────────────
var gs, player, bullets, rocks, sparks, ufo;
var sc, lv, lives, ufoT, tick;
var aiIn = { rot:0, thrust:false, fire:false };
var keys = {};

// ─── Math helpers ───────────────────────────────────────────────────────────
function dst(ax,ay,bx,by) { var dx=ax-bx,dy=ay-by; return Math.sqrt(dx*dx+dy*dy); }
function wrp(v,m) { return v<0?v+m:v>m?v-m:v; }
function normA(a) { while(a>Math.PI)a-=Math.PI*2; while(a<-Math.PI)a+=Math.PI*2; return a; }
function wdx(a,b){ var d=a-b; if(d>CW/2)d-=CW; else if(d<-CW/2)d+=CW; return d; }
function wdy(a,b){ var d=a-b; if(d>CH/2)d-=CH; else if(d<-CH/2)d+=CH; return d; }
function wdst(ax,ay,bx,by){ var dx=wdx(ax,bx),dy=wdy(ay,by); return Math.sqrt(dx*dx+dy*dy); }

// ─── Game logic ─────────────────────────────────────────────────────────────
function initGame() {
    sc=0; lv=1; lives=3; ufoT=0; tick=0;
    bullets=[]; rocks=[]; sparks=[]; ufo=null;
    spawnPlayer();
    spawnRocks(4);
    gs='playing';
}

function spawnPlayer() {
    player = { x:CW/2, y:CH/2, vx:0, vy:0,
               angle:-Math.PI/2, iframes:0, cooldown:0,
               dead:false, thrusting:false };
}

function spawnRocks(n) {
    rocks = [];
    for (var i = 0; i < n; i++) addRock(3, null, null);
}

function addRock(sz, x, y) {
    if (x == null) {
        var px = player ? player.x : CW/2, py = player ? player.y : CH/2;
        var tries = 0;
        do { x=Math.random()*CW; y=Math.random()*CH; tries++; }
        while (tries < 20 && dst(x,y,px,py) < 110);
    }
    var ang = Math.random()*Math.PI*2;
    var spd = SPEEDS[sz] * (0.7 + Math.random()*0.6);
    rocks.push({ x:x, y:y, vx:Math.cos(ang)*spd, vy:Math.sin(ang)*spd,
                 sz:sz, r:RADII[sz] });
}

function fireBullet() {
    var p = player;
    var own = 0; for (var i=0; i<bullets.length; i++) if (bullets[i].own) own++;
    if (own >= 4) return;
    bullets.push({ x:p.x+Math.cos(p.angle)*(SHIP_R+3),
                   y:p.y+Math.sin(p.angle)*(SHIP_R+3),
                   vx:p.vx+Math.cos(p.angle)*B_SPD,
                   vy:p.vy+Math.sin(p.angle)*B_SPD,
                   age:0, own:true });
}

function killPlayer() {
    if (player.iframes > 0) return;
    player.dead = true;
    lives--;
    if (lives <= 0) { gs='gameover'; return; }
    // Respawn after delay (in headless, just respawn immediately)
    spawnPlayer(); player.iframes = 180;
}

function stepPlayer() {
    var p = player;
    var left  = aiIn.rot < 0;
    var right = aiIn.rot > 0;
    var thr   = aiIn.thrust;

    if (left)  p.angle -= TURN;
    if (right) p.angle += TURN;

    p.thrusting = thr;
    if (thr) {
        p.vx += Math.cos(p.angle)*ACCEL;
        p.vy += Math.sin(p.angle)*ACCEL;
        var spd = Math.sqrt(p.vx*p.vx + p.vy*p.vy);
        if (spd > VMAX) { p.vx *= VMAX/spd; p.vy *= VMAX/spd; }
    }
    p.vx *= FRIC; p.vy *= FRIC;
    p.x = wrp(p.x+p.vx, CW); p.y = wrp(p.y+p.vy, CH);

    if (p.cooldown > 0) p.cooldown--;
    // AI fires directly in computeAI, not here

    if (p.iframes > 0) p.iframes--;
}

function stepRocks() {
    for (var i = 0; i < rocks.length; i++) {
        var r = rocks[i];
        r.x = wrp(r.x+r.vx, CW); r.y = wrp(r.y+r.vy, CH);
        if (player && !player.dead && player.iframes <= 0)
            if (dst(player.x,player.y,r.x,r.y) < r.r+SHIP_R) killPlayer();
    }
}

function stepBullets() {
    outer: for (var i = bullets.length-1; i >= 0; i--) {
        var b = bullets[i];
        b.x = wrp(b.x+b.vx, CW); b.y = wrp(b.y+b.vy, CH); b.age++;
        if (b.age > B_LIFE) { bullets.splice(i,1); continue; }
        if (b.own) {
            for (var j = rocks.length-1; j >= 0; j--) {
                if (dst(b.x,b.y,rocks[j].x,rocks[j].y) < rocks[j].r) {
                    smashRock(j); bullets.splice(i,1); continue outer;
                }
            }
            if (ufo && dst(b.x,b.y,ufo.x,ufo.y) < ufo.r) {
                sc += ufo.big ? 200 : 1000;
                ufo = null;
                bullets.splice(i,1); continue outer;
            }
        } else {
            if (player && !player.dead && player.iframes <= 0)
                if (dst(b.x,b.y,player.x,player.y) < SHIP_R) {
                    killPlayer(); bullets.splice(i,1); continue outer;
                }
        }
    }
}

function smashRock(idx) {
    var r = rocks[idx];
    sc += APTS[r.sz];
    if (r.sz > 1) { addRock(r.sz-1,r.x,r.y); addRock(r.sz-1,r.x,r.y); }
    rocks.splice(idx, 1);
}

function stepUFO() {
    ufoT++;
    if (lv >= 2 && !ufo && ufoT > Math.max(600, UFO_INT - lv*80)) {
        ufoT = 0;
        var side = Math.random() < .5 ? -20 : CW+20;
        var big  = lv < 5 || Math.random() < .6;
        var spd  = big ? 1.8 : 2.5;
        ufo = { x:side, y:60+Math.random()*(CH-120),
                vx:side<0?spd:-spd, vy:0,
                r:big?18:12, big:big,
                shotT:big?100:65, wobT:0 };
    }
    if (!ufo) return;
    ufo.x += ufo.vx; ufo.y += ufo.vy;
    ufo.wobT++;
    if (ufo.wobT % 80 === 0) ufo.vy = (Math.random()-.5)*1.8;
    ufo.vy *= .98;
    ufo.y = Math.max(30, Math.min(CH-30, ufo.y));
    if (player && !player.dead) {
        ufo.shotT--;
        if (ufo.shotT <= 0) {
            ufo.shotT = ufo.big ? 100 : 65;
            var ang = ufo.big ? Math.random()*Math.PI*2
                              : Math.atan2(player.y-ufo.y, player.x-ufo.x);
            bullets.push({ x:ufo.x, y:ufo.y,
                           vx:Math.cos(ang)*B_SPD*.7, vy:Math.sin(ang)*B_SPD*.7,
                           age:0, own:false });
        }
    }
    if (player && !player.dead && player.iframes <= 0)
        if (dst(player.x,player.y,ufo.x,ufo.y) < ufo.r+SHIP_R) killPlayer();
    if (ufo && (ufo.x < -60 || ufo.x > CW+60)) ufo = null;
}

// ─── Rule-based AI (copied from game) ──────────────────────────────────────
function computeAI() {
    aiIn.rot = 0; aiIn.thrust = false; aiIn.fire = false;
    var p = player;

    var fleeX=0, fleeY=0, hardThreat=false, minTTC=Infinity;

    function addThreat(tx,ty,tvx,tvy,tr,mul) {
        var dx=wdx(p.x,tx), dy=wdy(p.y,ty);
        var d=Math.sqrt(dx*dx+dy*dy)||1;
        var eff=d-tr-SHIP_R;
        var rvx=tvx-p.vx, rvy=tvy-p.vy;
        var closing=(dx*rvx+dy*rvy)/d;
        var w=0;
        if (closing>0.1) {
            var ttc=Math.max(0,eff)/closing;
            if (ttc<minTTC) minTTC=ttc;
            if (ttc<150) { w=Math.pow((150-ttc)/150,2)*mul; if(ttc<30)hardThreat=true; }
        } else if (eff<70) {
            w=((70-eff)/70)*0.5*mul;
            if (eff<15) hardThreat=true;
        }
        if (w>0.001) { fleeX+=(dx/d)*w; fleeY+=(dy/d)*w; }
    }

    for (var i=0; i<rocks.length; i++) { var r=rocks[i]; addThreat(r.x,r.y,r.vx,r.vy,r.r,1.0); }
    if (ufo) addThreat(ufo.x,ufo.y,ufo.vx,ufo.vy,ufo.r,1.5);
    for (var i=0; i<bullets.length; i++) { var b=bullets[i]; if(!b.own) addThreat(b.x,b.y,b.vx,b.vy,3,2.5); }

    var dodging=(fleeX*fleeX+fleeY*fleeY)>0.04;
    var fleeA=dodging?Math.atan2(fleeY,fleeX):0;

    function interceptA(t) {
        var rx=wdx(t.x,p.x), ry=wdy(t.y,p.y);
        var rvx=(t.vx||0)-p.vx, rvy=(t.vy||0)-p.vy;
        var qa=rvx*rvx+rvy*rvy-B_SPD*B_SPD;
        var qb=2*(rx*rvx+ry*rvy), qc=rx*rx+ry*ry;
        var tt=null;
        if (Math.abs(qa)<0.001) { if(qb<-0.001) tt=-qc/qb; }
        else {
            var disc=qb*qb-4*qa*qc;
            if (disc>=0) {
                var sq=Math.sqrt(disc);
                var t1=(-qb-sq)/(2*qa), t2=(-qb+sq)/(2*qa);
                if(t1>0&&t2>0)tt=Math.min(t1,t2); else if(t1>0)tt=t1; else if(t2>0)tt=t2;
            }
        }
        if (tt===null||tt>=B_LIFE) return null;
        return { a:Math.atan2(ry+rvy*tt, rx+rvx*tt), tt:tt, rx:rx, ry:ry };
    }

    var tgt=null;
    if (ufo && wdst(p.x,p.y,ufo.x,ufo.y)<350) {
        tgt=ufo;
    } else if (rocks.length>0) {
        var bestRot=Infinity, bestRotAll=Infinity, tgtAll=null;
        for (var i=0; i<rocks.length; i++) {
            var r=rocks[i];
            var ric=interceptA(r);
            var rot=(ric ? Math.abs(normA(ric.a-p.angle)) : Math.PI) + (r.sz-1)*Math.PI/2;
            if (rot<bestRotAll) { bestRotAll=rot; tgtAll=r; }
            if (wdst(p.x,p.y,r.x,r.y) < DODGE_SOFT && rot<bestRot) { bestRot=rot; tgt=r; }
        }
        if (!tgt) tgt=tgtAll;
    }

    var leadX=null, leadY=null, aimA=null, aimDiff=null;
    var ic = null;
    if (tgt) {
        ic=interceptA(tgt);
        if (ic) {
            aimA=ic.a;
            leadX=p.x+ic.rx+(tgt.vx||0)*ic.tt;
            leadY=p.y+ic.ry+(tgt.vy||0)*ic.tt;
        } else {
            aimA=Math.atan2(wdy(tgt.y,p.y), wdx(tgt.x,p.x));
        }
        aimDiff=normA(aimA-p.angle);
    }

    if (p.cooldown===0) {
        var fired=false;
        if (ic && aimDiff!==null) {
            var primTol = Math.atan2((tgt.r||15) * 1.5, B_SPD * ic.tt);
            if (Math.abs(aimDiff) < primTol) { fireBullet(); p.cooldown=6; fired=true; aiIn.fire=true; }
        }
        if (!fired) {
            var opps = ufo ? rocks.concat([ufo]) : rocks;
            for (var i=0; i<opps.length&&!fired; i++) {
                if (opps[i]===tgt) continue;
                var oic=interceptA(opps[i]);
                if (oic) {
                    var oppTol = Math.atan2((opps[i].r||15), B_SPD * oic.tt);
                    if (Math.abs(normA(oic.a-p.angle)) < oppTol) {
                        fireBullet(); p.cooldown=6; fired=true; aiIn.fire=true;
                    }
                }
            }
        }
    }

    if (dodging) {
        var diff=normA(fleeA-p.angle);
        if(diff>0.1)aiIn.rot=1; else if(diff<-0.1)aiIn.rot=-1;
        aiIn.thrust=hardThreat||Math.abs(diff)<0.5;
        if (minTTC<10) {
            // Hyperspace — just teleport in headless
            p.x = 20+Math.random()*(CW-40);
            p.y = 20+Math.random()*(CH-40);
        }
    } else if (aimA!==null) {
        if(aimDiff>0.1)aiIn.rot=1; else if(aimDiff<-0.1)aiIn.rot=-1;
        var td=wdst(p.x,p.y,tgt.x,tgt.y);
        var spd=Math.sqrt(p.vx*p.vx+p.vy*p.vy);
        if(td>190&&Math.abs(aimDiff)<0.5)aiIn.thrust=true;
        else if(td>90&&spd<2.5&&Math.abs(aimDiff)<0.3)aiIn.thrust=true;
    }
}

function update() {
    if (gs !== 'playing') return;
    tick++;
    if (player && !player.dead) computeAI();
    if (player && !player.dead) stepPlayer();
    stepRocks();
    stepBullets();
    stepUFO();
    // Skip sparks — visual only

    if (rocks.length === 0 && !ufo) {
        lv++;
        var n = Math.min(2 + lv*2, 11);
        spawnRocks(n);
        if (player) { player.vx=0; player.vy=0; player.iframes=120; }
    }
}

// ─── Feature extraction (must match browser version exactly) ────────────────
var N_ROCKS = 5;
var N_FEAT = N_ROCKS * 8 + 5 + 1 + 3 + 5 + 4; // 58

function extractState() {
    var p = player;
    if (!p) return null;

    var feat = new Float32Array(N_FEAT);
    var fi = 0;
    var maxDist = Math.sqrt(CW*CW + CH*CH) * 0.5;

    var spd = Math.sqrt(p.vx*p.vx + p.vy*p.vy);
    feat[fi++] = spd / VMAX;
    feat[fi++] = p.vx / VMAX;
    feat[fi++] = p.vy / VMAX;
    feat[fi++] = Math.cos(p.angle);
    feat[fi++] = Math.sin(p.angle);
    feat[fi++] = p.cooldown / 6;

    var rks = [];
    var minTTC_f = 999, maxDanger = 0, numClose = 0;
    for (var i = 0; i < rocks.length; i++) {
        var r = rocks[i];
        var dx = wdx(r.x, p.x), dy = wdy(r.y, p.y);
        var d = Math.sqrt(dx*dx + dy*dy) || 1;
        var rvx = r.vx - p.vx, rvy = r.vy - p.vy;
        var closing = (dx*rvx + dy*rvy) / d;
        var angToRock = Math.atan2(dy, dx);
        var relAng = normA(angToRock - p.angle);
        var eff = d - r.r - SHIP_R;
        var danger = 0;
        if (closing > 0.1) {
            var ttc = Math.max(0, eff) / closing;
            if (ttc < minTTC_f) minTTC_f = ttc;
            if (ttc < 150) danger = Math.pow((150 - ttc) / 150, 2);
        } else if (eff < 70) {
            danger = ((70 - eff) / 70) * 0.5;
        }
        if (danger > maxDanger) maxDanger = danger;
        if (d < 130) numClose++;
        rks.push({ dx:dx, dy:dy, d:d, rvx:rvx, rvy:rvy, closing:closing,
                    relAng:relAng, sz:r.sz, r:r.r, danger:danger });
    }
    rks.sort(function(a,b) { return a.d - b.d; });

    feat[fi++] = Math.min(minTTC_f / 150, 1);
    feat[fi++] = Math.min(maxDanger, 1);
    feat[fi++] = Math.min(numClose / 5, 1);

    for (var i = 0; i < N_ROCKS; i++) {
        if (i < rks.length) {
            var rk = rks[i];
            feat[fi++] = Math.sin(rk.relAng);
            feat[fi++] = Math.cos(rk.relAng);
            feat[fi++] = Math.min(rk.d / maxDist, 1);
            feat[fi++] = rk.rvx / (VMAX * 2);
            feat[fi++] = rk.rvy / (VMAX * 2);
            feat[fi++] = rk.closing / (VMAX * 2);
            feat[fi++] = rk.sz / 3;
            feat[fi++] = Math.min(rk.danger, 1);
        } else { fi += 8; }
    }

    if (ufo) {
        var udx = wdx(ufo.x, p.x), udy = wdy(ufo.y, p.y);
        var ud = Math.sqrt(udx*udx + udy*udy) || 1;
        var uRelAng = normA(Math.atan2(udy, udx) - p.angle);
        var urvx = (ufo.vx||0) - p.vx, urvy = (ufo.vy||0) - p.vy;
        feat[fi++] = 1;
        feat[fi++] = Math.sin(uRelAng);
        feat[fi++] = Math.cos(uRelAng);
        feat[fi++] = Math.min(ud / maxDist, 1);
        feat[fi++] = (udx*urvx + udy*urvy) / (ud * VMAX * 2);
    } else { fi += 5; }

    var bestBD = Infinity, bestBul = null, bestBdx = 0, bestBdy = 0;
    for (var i = 0; i < bullets.length; i++) {
        var b = bullets[i];
        if (b.own) continue;
        var bdx = wdx(b.x, p.x), bdy = wdy(b.y, p.y);
        var bd = Math.sqrt(bdx*bdx + bdy*bdy);
        if (bd < bestBD) { bestBD = bd; bestBul = b; bestBdx = bdx; bestBdy = bdy; }
    }
    if (bestBul) {
        var bRelAng = normA(Math.atan2(bestBdy, bestBdx) - p.angle);
        feat[fi++] = Math.sin(bRelAng);
        feat[fi++] = Math.cos(bRelAng);
        feat[fi++] = Math.min(bestBD / maxDist, 1);
        var brvx = bestBul.vx - p.vx, brvy = bestBul.vy - p.vy;
        feat[fi++] = (bestBdx*brvx + bestBdy*brvy) / (bestBD * B_SPD);
    }

    return feat;
}

function extractAction() {
    var rotClass = aiIn.rot < 0 ? 0 : aiIn.rot > 0 ? 2 : 1;
    return [rotClass, aiIn.thrust ? 1 : 0, aiIn.fire ? 1 : 0];
}

// ─── Data collection ────────────────────────────────────────────────────────
function collectData(nSamples) {
    var dataX = [], dataY = [];
    initGame();
    while (dataX.length < nSamples) {
        if (gs !== 'playing') { initGame(); continue; }
        if (!player || player.dead) { update(); continue; }
        var feat = extractState();
        update();
        if (feat) {
            dataX.push(feat);
            dataY.push(extractAction());
        }
    }
    return { X: dataX, Y: dataY };
}

// ─── Neural network ─────────────────────────────────────────────────────────
var N_H1 = 128, N_H2 = 64, N_OUT = 5;
var W1, b1, W2, b2, W3, b3;
var _h1 = new Float32Array(N_H1), _h2 = new Float32Array(N_H2);
var _out = new Float32Array(N_OUT), _logits = new Float32Array(N_OUT);
var _dOut = new Float32Array(N_OUT), _dH2 = new Float32Array(N_H2), _dH1 = new Float32Array(N_H1);
var gW1, gb1, gW2, gb2, gW3, gb3;

function randn() {
    return Math.sqrt(-2*Math.log(1-Math.random()))*Math.cos(2*Math.PI*Math.random());
}

function initWeights() {
    var s1 = Math.sqrt(2/N_FEAT), s2 = Math.sqrt(2/N_H1), s3 = Math.sqrt(2/N_H2);
    W1 = new Float32Array(N_H1 * N_FEAT); b1 = new Float32Array(N_H1);
    W2 = new Float32Array(N_H2 * N_H1);   b2 = new Float32Array(N_H2);
    W3 = new Float32Array(N_OUT * N_H2);   b3 = new Float32Array(N_OUT);
    for (var i = 0; i < W1.length; i++) W1[i] = randn() * s1;
    for (var i = 0; i < W2.length; i++) W2[i] = randn() * s2;
    for (var i = 0; i < W3.length; i++) W3[i] = randn() * s3;
}

function allocGrads() {
    gW1 = new Float32Array(N_H1 * N_FEAT); gb1 = new Float32Array(N_H1);
    gW2 = new Float32Array(N_H2 * N_H1);   gb2 = new Float32Array(N_H2);
    gW3 = new Float32Array(N_OUT * N_H2);   gb3 = new Float32Array(N_OUT);
}

function forward(x) {
    var j, i, s;
    for (j = 0; j < N_H1; j++) {
        s = b1[j]; var off = j*N_FEAT;
        for (i = 0; i < N_FEAT; i++) s += W1[off+i] * x[i];
        _h1[j] = s > 0 ? s : 0;
    }
    for (j = 0; j < N_H2; j++) {
        s = b2[j]; var off = j*N_H1;
        for (i = 0; i < N_H1; i++) s += W2[off+i] * _h1[i];
        _h2[j] = s > 0 ? s : 0;
    }
    for (j = 0; j < N_OUT; j++) {
        s = b3[j]; var off = j*N_H2;
        for (i = 0; i < N_H2; i++) s += W3[off+i] * _h2[i];
        _logits[j] = s;
    }
    var maxL = _logits[0]; if (_logits[1]>maxL) maxL=_logits[1]; if (_logits[2]>maxL) maxL=_logits[2];
    var e0=Math.exp(_logits[0]-maxL), e1=Math.exp(_logits[1]-maxL), e2=Math.exp(_logits[2]-maxL);
    var eSum = e0+e1+e2;
    _out[0] = e0/eSum; _out[1] = e1/eSum; _out[2] = e2/eSum;
    for (j = 3; j < N_OUT; j++) {
        s = _logits[j]; s = s > 15 ? 15 : s < -15 ? -15 : s;
        _out[j] = 1 / (1 + Math.exp(-s));
    }
}

function accumGrads(x, y) {
    forward(x);
    var j, i, d, off;
    var loss = 0;
    var rotClass = y[0];
    for (j = 0; j < 3; j++) {
        var p = Math.max(1e-7, _out[j]);
        if (j === rotClass) loss -= Math.log(p);
        _dOut[j] = _out[j] - (j === rotClass ? 1 : 0);
    }
    var bceW = [2.0, 3.0];
    for (j = 3; j < N_OUT; j++) {
        var o = _out[j]; o = o < 1e-7 ? 1e-7 : o > 0.9999999 ? 0.9999999 : o;
        var yj = y[j - 2];
        var w = bceW[j-3];
        var pw = yj === 1 ? w : 1;
        loss += pw * -(yj * Math.log(o) + (1-yj) * Math.log(1-o));
        _dOut[j] = pw * (o - yj);
    }

    _dH2.fill(0);
    for (j = 0; j < N_OUT; j++) {
        d = _dOut[j]; off = j*N_H2;
        for (i = 0; i < N_H2; i++) _dH2[i] += d * W3[off+i];
        gb3[j] += d;
        for (i = 0; i < N_H2; i++) gW3[off+i] += d * _h2[i];
    }
    for (i = 0; i < N_H2; i++) if (_h2[i] <= 0) _dH2[i] = 0;

    _dH1.fill(0);
    for (j = 0; j < N_H2; j++) {
        d = _dH2[j]; off = j*N_H1;
        for (i = 0; i < N_H1; i++) _dH1[i] += d * W2[off+i];
        gb2[j] += d;
        for (i = 0; i < N_H1; i++) gW2[off+i] += d * _h1[i];
    }
    for (i = 0; i < N_H1; i++) if (_h1[i] <= 0) _dH1[i] = 0;

    for (j = 0; j < N_H1; j++) {
        d = _dH1[j]; off = j*N_FEAT;
        gb1[j] += d;
        for (i = 0; i < N_FEAT; i++) gW1[off+i] += d * x[i];
    }

    return loss / N_OUT;
}

// Adam optimizer
var adamBeta1 = 0.9, adamBeta2 = 0.999, adamEps = 1e-8;
var mW1, vW1, mb1, vb1, mW2, vW2, mb2, vb2, mW3, vW3, mb3, vb3;
var adamT = 0;

function allocAdam() {
    mW1 = new Float32Array(W1.length); vW1 = new Float32Array(W1.length);
    mb1 = new Float32Array(b1.length); vb1 = new Float32Array(b1.length);
    mW2 = new Float32Array(W2.length); vW2 = new Float32Array(W2.length);
    mb2 = new Float32Array(b2.length); vb2 = new Float32Array(b2.length);
    mW3 = new Float32Array(W3.length); vW3 = new Float32Array(W3.length);
    mb3 = new Float32Array(b3.length); vb3 = new Float32Array(b3.length);
    adamT = 0;
}

function adamStep(w, g, m, v, lr, invBs, bc1, bc2) {
    for (var i = 0; i < w.length; i++) {
        var gi = g[i] * invBs;
        m[i] = adamBeta1 * m[i] + (1 - adamBeta1) * gi;
        v[i] = adamBeta2 * v[i] + (1 - adamBeta2) * gi * gi;
        w[i] -= lr * (m[i] * bc1) / (Math.sqrt(v[i] * bc2) + adamEps);
    }
}

function applyGrads(lr, batchSize) {
    adamT++;
    var bc1 = 1 / (1 - Math.pow(adamBeta1, adamT));
    var bc2 = 1 / (1 - Math.pow(adamBeta2, adamT));
    var invBs = 1 / batchSize;
    adamStep(W1, gW1, mW1, vW1, lr, invBs, bc1, bc2);
    adamStep(b1, gb1, mb1, vb1, lr, invBs, bc1, bc2);
    adamStep(W2, gW2, mW2, vW2, lr, invBs, bc1, bc2);
    adamStep(b2, gb2, mb2, vb2, lr, invBs, bc1, bc2);
    adamStep(W3, gW3, mW3, vW3, lr, invBs, bc1, bc2);
    adamStep(b3, gb3, mb3, vb3, lr, invBs, bc1, bc2);
}

// ─── Training ───────────────────────────────────────────────────────────────
function train(dataX, dataY, epochs, batchSize, lr) {
    var n = dataX.length;
    var idx = [];
    for (var i = 0; i < n; i++) idx.push(i);

    for (var epoch = 0; epoch < epochs; epoch++) {
        // Shuffle
        for (var i = n-1; i > 0; i--) {
            var j = Math.floor(Math.random()*(i+1));
            var t = idx[i]; idx[i] = idx[j]; idx[j] = t;
        }
        var totalLoss = 0;
        for (var b = 0; b < n; b += batchSize) {
            var end = Math.min(b + batchSize, n);
            var bs = end - b;
            gW1.fill(0); gb1.fill(0); gW2.fill(0); gb2.fill(0); gW3.fill(0); gb3.fill(0);
            for (var i = b; i < end; i++) {
                totalLoss += accumGrads(dataX[idx[i]], dataY[idx[i]]);
            }
            applyGrads(lr, bs);
        }
        var avgLoss = totalLoss / n;
        if (epoch % 10 === 0 || epoch === epochs - 1) {
            process.stdout.write('Epoch ' + (epoch+1) + '/' + epochs + ' | Loss: ' + avgLoss.toFixed(4) + '\n');
        }
    }
    return avgLoss;
}

// ─── Evaluate: run ML agent and report average score ────────────────────────
function evaluate(nGames) {
    var scores = [];
    for (var g = 0; g < nGames; g++) {
        initGame();
        var maxTicks = 20000;
        for (var t = 0; t < maxTicks && gs === 'playing'; t++) {
            if (player && !player.dead) {
                // ML inference
                var feat = extractState();
                if (feat) {
                    forward(feat);
                    aiIn.rot = 0;
                    if (_out[0] > _out[1] && _out[0] > _out[2]) aiIn.rot = -1;
                    else if (_out[2] > _out[1] && _out[2] > _out[0]) aiIn.rot = 1;
                    aiIn.thrust = _out[3] > 0.5;
                    aiIn.fire = _out[4] > 0.5;
                    // Handle firing
                    if (aiIn.fire && player.cooldown === 0) {
                        fireBullet(); player.cooldown = 4;
                    }
                }
                stepPlayer();
            }
            // Don't run computeAI — we're testing the ML agent
            stepRocks();
            stepBullets();
            stepUFO();
            if (rocks.length === 0 && !ufo) {
                lv++;
                var n = Math.min(2 + lv*2, 11);
                spawnRocks(n);
                if (player) { player.vx=0; player.vy=0; player.iframes=120; }
            }
        }
        scores.push(sc);
    }
    var avg = scores.reduce(function(a,b){return a+b;}, 0) / scores.length;
    var max = Math.max.apply(null, scores);
    return { avg: avg, max: max, scores: scores };
}

// ─── Main ───────────────────────────────────────────────────────────────────
console.log('Collecting 100k training samples...');
var t0 = Date.now();
var data = collectData(100000);
console.log('Collected in ' + ((Date.now()-t0)/1000).toFixed(1) + 's');

// Check class balance
var rotCounts = [0,0,0], thrustCount = 0, fireCount = 0;
for (var i = 0; i < data.Y.length; i++) {
    rotCounts[data.Y[i][0]]++;
    if (data.Y[i][1]) thrustCount++;
    if (data.Y[i][2]) fireCount++;
}
console.log('Class balance:');
console.log('  Rot: left=' + rotCounts[0] + ' none=' + rotCounts[1] + ' right=' + rotCounts[2]);
console.log('  Thrust: ' + thrustCount + '/' + data.Y.length + ' (' + (100*thrustCount/data.Y.length).toFixed(1) + '%)');
console.log('  Fire: ' + fireCount + '/' + data.Y.length + ' (' + (100*fireCount/data.Y.length).toFixed(1) + '%)');

console.log('\nTraining (200 epochs, batch=128, lr=0.001)...');
initWeights();
allocGrads();
allocAdam();
t0 = Date.now();
var finalLoss = train(data.X, data.Y, 200, 128, 0.001);
console.log('Training done in ' + ((Date.now()-t0)/1000).toFixed(1) + 's');

console.log('\nEvaluating ML agent (20 games)...');
var result = evaluate(20);
console.log('Avg score: ' + result.avg.toFixed(0) + ' | Max: ' + result.max);
console.log('Scores: ' + result.scores.join(', '));

// Evaluate rule AI for comparison
console.log('\nEvaluating rule AI (20 games)...');
var ruleScores = [];
for (var g = 0; g < 20; g++) {
    initGame();
    for (var t = 0; t < 20000 && gs === 'playing'; t++) { update(); }
    ruleScores.push(sc);
}
var ruleAvg = ruleScores.reduce(function(a,b){return a+b;}, 0) / ruleScores.length;
console.log('Rule AI avg: ' + ruleAvg.toFixed(0) + ' | Max: ' + Math.max.apply(null, ruleScores));

// Export weights as JSON
var weights = {
    W1: Array.from(W1), b1: Array.from(b1),
    W2: Array.from(W2), b2: Array.from(b2),
    W3: Array.from(W3), b3: Array.from(b3)
};
var fs = require('fs');
fs.writeFileSync('asteroids-ml-weights.json', JSON.stringify(weights));
console.log('\nWeights saved to asteroids-ml-weights.json');
