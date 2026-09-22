// SPDX-License-Identifier: AGPL-3.0-or-later
// The cache name and precache list are filled in by scripts/package.py.
const CACHE='__CACHE__';
const FILES=[__FILES__];
const PAGES={'/':'./','/perspective':'./perspective','/fuji':'./fuji','/social':'./social','/ela':'./ela'};
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)));});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==self.location.origin)return;
  const path=url.pathname.replace(/\/+$/,'')||'/';
  if(e.request.mode==='navigate'||path in PAGES){
    // Pages: network first so a new deploy is picked up on the next open; cache only when offline.
    e.respondWith(fetch(e.request).then(r=>{if(r.ok)caches.open(CACHE).then(c=>c.put(PAGES[path]||e.request,r.clone()));return r;})
      .catch(async()=>{const c=await caches.open(CACHE);return (await c.match(PAGES[path]||'./'))||c.match('./');}));
    return;
  }
  // Hashed assets never change under the same name: cache first.
  e.respondWith(caches.open(CACHE).then(async c=>{
    const cached=await c.match(e.request,{ignoreSearch:true});if(cached)return cached;
    const r=await fetch(e.request);if(r.ok&&url.pathname.startsWith('/static/'))c.put(e.request,r.clone());return r;
  }));
});
