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

document.addEventListener('fullscreenchange', updateFullscreenBtn);
document.addEventListener('webkitfullscreenchange', updateFullscreenBtn);

function updateFullscreenBtn() {
    var btn = document.getElementById('fs-btn');
    if (!btn) return;
    var isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    btn.textContent = isFs ? 'Exit FS' : 'Fullscreen';
}
