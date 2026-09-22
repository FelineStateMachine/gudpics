// SPDX-License-Identifier: AGPL-3.0-or-later
const CACHE='gudpics-v1';
const FILES=['./','./index.html','./perspective','./fuji','./style.css','./viewport.js','./home.mjs','./app.mjs','./fuji.mjs','./raf.mjs','./worker.mjs','./geometry.mjs','./manifest.webmanifest','./assets/core.mjs','./assets/core.wasm','./assets/icon.svg','./assets/icon-192.png','./assets/icon-512.png','./NOTICE.md','./LICENSES/AGPL-3.0.txt','./LICENSES/GPL-3.0.txt'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)));});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==self.location.origin)return;
  e.respondWith(caches.open(CACHE).then(async c=>{
    const cached=await c.match(e.request,{ignoreSearch:true});if(cached)return cached;
    try{return await fetch(e.request);}
    catch(error){
      if(e.request.mode==='navigate')return (await c.match(url.pathname.replace(/\/$/,'').endsWith('/perspective')?'./perspective':'./index.html'))||c.match('./index.html');
      throw error;
    }
  }));
});
