// SPDX-License-Identifier: AGPL-3.0-or-later
const $=id=>document.getElementById(id);
const standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
const ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
let installPrompt;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;if(!standalone)$('install').hidden=false;});
$('install').onclick=async()=>{await installPrompt?.prompt();installPrompt=null;$('install').hidden=true;};
if(ios&&!standalone)$('install-ios').hidden=false;
$('install-ios').onclick=()=>{$('info').showModal();$('install-help').scrollIntoView({block:'center'});};
$('about').onclick=()=>$('info').showModal();
$('close-info').onclick=()=>$('info').close();
$('info').onclick=e=>{if(e.target===$('info'))$('info').close();};
if('serviceWorker'in navigator){
  let hadController=Boolean(navigator.serviceWorker.controller);navigator.serviceWorker.addEventListener('controllerchange',()=>{if(hadController)location.reload();hadController=true;});
  navigator.serviceWorker.register('./sw.js').then(async()=>{await navigator.serviceWorker.ready;$('offline-status').textContent='Works offline.';}).catch(()=>{});
}
