/* Fullscreen toggle for all Dino Arcade games */
function toggleFullscreen() {
    var el = document.querySelector('.si-game-box');
    if (!el) return;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
        (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    }
}

document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

function onFullscreenChange() {
    var btn = document.getElementById('fs-btn');
    var isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (btn) btn.textContent = isFs ? 'Exit FS' : 'Fullscreen';

    if (isFs) {
        requestAnimationFrame(function() {
            requestAnimationFrame(function() {
                applyFullscreenScale();
            });
        });
    } else {
        removeFullscreenScale();
    }
}

function applyFullscreenScale() {
    var box = document.fullscreenElement || document.webkitFullscreenElement;
    if (!box) return;

    var wrapper = box.querySelector('.game-wrapper');
    var canvas = box.querySelector('canvas');
    if (!canvas) return;

    var target = wrapper || canvas;

    // Reset any previous scaling
    target.style.transform = 'none';

    // Get the canvas intrinsic rendered size
    var contentW = canvas.offsetWidth;
    var contentH = canvas.offsetHeight;

    // Measure controls before any layout changes
    var controls = box.querySelector('.si-controls');
    var helpText = box.querySelector('.si-help');
    var controlsH = 0;
    if (controls) controlsH += controls.offsetHeight;
    if (helpText) controlsH += helpText.offsetHeight;
    controlsH += 40; // padding

    var availW = window.innerWidth;
    var availH = window.innerHeight - controlsH;

    var scale = Math.min(availW / contentW, availH / contentH);

    if (wrapper) {
        // Pin wrapper to canvas size and scale from top-center
        wrapper.style.flex = 'none';
        wrapper.style.width = contentW + 'px';
        wrapper.style.height = contentH + 'px';
        wrapper.style.overflow = 'hidden';
        // Reserve visual space below so controls aren't covered
        wrapper.style.marginBottom = (contentH * (scale - 1)) + 'px';
    }

    target.style.transformOrigin = 'top center';
    target.style.transform = 'scale(' + scale + ')';
}

function removeFullscreenScale() {
    var wrapper = document.querySelector('.game-wrapper');
    if (wrapper) {
        wrapper.style.transform = '';
        wrapper.style.transformOrigin = '';
        wrapper.style.flex = '';
        wrapper.style.width = '';
        wrapper.style.height = '';
        wrapper.style.overflow = '';
        wrapper.style.marginBottom = '';
    }
    var canvases = document.querySelectorAll('.si-game-box > canvas');
    for (var i = 0; i < canvases.length; i++) {
        canvases[i].style.transform = '';
        canvases[i].style.transformOrigin = '';
    }
}
