// SPDX-License-Identifier: AGPL-3.0-or-later
// viewport-fit=cover is needed on iOS for the notch and home indicator. On Android Chrome it
// draws the page under the gesture bar, hiding the bottom of the layout, so only iOS keeps it.
(function(){
  var ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  if(ios)return;
  var m=document.querySelector('meta[name=viewport]');
  if(m)m.content=m.content.replace(/,\s*viewport-fit=cover/,'');
})();
