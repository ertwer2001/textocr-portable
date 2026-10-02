/* Only application assets are cached. Imported user files never enter this cache. */
const VERSION='textocr-web-20261002-r5';
const CORE=['./','index.html','style.css','app.js','analysis.js','exports.js','ocr.js','ocr.worker.js','icon.svg','manifest.webmanifest','licenses.html','asset-manifest.json','models/manifest.json','vendor/jszip.min.js'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(VERSION).then(cache=>cache.addAll(CORE)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('textocr-web-')&&key!==VERSION).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith((async()=>{
    const cache=await caches.open(VERSION);
    // Keep app fixes current on reload; cached models still work offline.
    const path=new URL(event.request.url).pathname;
    if(event.request.mode==='navigate'||CORE.some(file=>new URL(file,self.registration.scope).pathname===path)){
      try{const response=await fetch(event.request);if(response.ok){await cache.put(event.request,response.clone());return response;}}catch{}
    }
    const cached=await cache.match(event.request);
    if(cached)return cached;
    const response=await fetch(event.request);
    if(response.ok&&new URL(event.request.url).pathname.startsWith(new URL(self.registration.scope).pathname))await cache.put(event.request,response.clone());
    return response;
  })());
});
self.addEventListener('message',event=>{
  if(event.data?.type!=='CACHE_ALL')return;
  const port=event.ports[0];
  event.waitUntil((async()=>{
    try{
      const [assets,models]=await Promise.all([fetch(new URL('asset-manifest.json',self.registration.scope)).then(response=>response.json()),fetch(new URL('models/manifest.json',self.registration.scope)).then(response=>response.json())]);
      const files=[...new Set([...CORE,...assets.files.map(item=>item.file),...Object.values(models).map(item=>'models/'+item.file),'examples/中英測試.png','examples/掃描測試.pdf','examples/文字與掃描混合.pdf'])];
      const cache=await caches.open(VERSION);
      for(let index=0;index<files.length;index++){
        const url=new URL(files[index],self.registration.scope).href;
        if(!await cache.match(url))await cache.add(url);
        port.postMessage({current:index+1,total:files.length});
      }
      port.postMessage({done:true});
    }catch(error){port.postMessage({error:'離線準備未完成：'+error.message+'。請確認網路連線後重試。'});}
  })());
});
