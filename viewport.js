// SPDX-License-Identifier: AGPL-3.0-or-later
// iOS needs viewport-fit=cover so the layout can extend under the notch and home indicator and
// read env(safe-area-inset-*). Android Chrome must never see it: once a window has gone edge-to-edge
// it does not reliably come back, and the bottom of the layout ends up under the gesture bar.
(function(){
  // Viewport units can resolve stale in an installed Android window, so the app height is measured.
  function fit(){document.documentElement.style.setProperty('--app-height',window.innerHeight+'px');}
  fit();window.addEventListener('resize',fit);window.addEventListener('orientationchange',fit);
  var ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  if(!ios)return;
  var m=document.querySelector('meta[name=viewport]');
  if(m&&m.content.indexOf('viewport-fit')<0)m.content+=', viewport-fit=cover';
})();
