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
        // Delay slightly so fullscreen layout settles
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
    if (!wrapper) return;

    // Measure natural size before scaling
    wrapper.style.transform = 'none';
    var wrapperW = wrapper.scrollWidth;
    var wrapperH = wrapper.scrollHeight;

    // Available space: fullscreen viewport minus controls area (~60px)
    var controls = box.querySelector('.si-controls');
    var controlsH = controls ? controls.offsetHeight + 20 : 60;
    var availW = window.innerWidth;
    var availH = window.innerHeight - controlsH;

    var scale = Math.min(availW / wrapperW, availH / wrapperH);

    wrapper.style.transformOrigin = 'center center';
    wrapper.style.transform = 'scale(' + scale + ')';
}

function removeFullscreenScale() {
    var wrapper = document.querySelector('.game-wrapper');
    if (wrapper) {
        wrapper.style.transform = '';
        wrapper.style.transformOrigin = '';
    }
}
