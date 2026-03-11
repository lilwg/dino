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

    // Reset transform to measure natural size
    target.style.transform = 'none';

    // Temporarily shrink-wrap the wrapper to get its natural content width
    if (wrapper) {
        wrapper.style.width = 'fit-content';
    }

    var contentW = target.offsetWidth;
    var contentH = target.offsetHeight;

    // Restore wrapper width
    if (wrapper) {
        wrapper.style.width = '';
    }

    var controls = box.querySelector('.si-controls');
    var controlsH = controls ? controls.offsetHeight + 20 : 60;
    var availW = window.innerWidth;
    var availH = window.innerHeight - controlsH;

    var scale = Math.min(availW / contentW, availH / contentH);

    target.style.transformOrigin = 'center center';
    target.style.transform = 'scale(' + scale + ')';
}

function removeFullscreenScale() {
    var targets = document.querySelectorAll('.game-wrapper, .si-game-box > canvas');
    for (var i = 0; i < targets.length; i++) {
        targets[i].style.transform = '';
        targets[i].style.transformOrigin = '';
    }
}
