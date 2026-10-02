import {createOCRWorker} from './ocr.js';
import {analyzePage} from './analysis.js';
import {exportDocument} from './exports.js';

const $ = id => document.getElementById(id);
const pages = [];
let activeId = null, serial = 0, busy = false, controller, ocr, ocrLoading, cvLoading, pdfjs;
let directory, downloadURL, dirty = false, workerRegistration;
const supportedImages = /\.(png|jpe?g|webp|bmp|gif)$/i;
const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));
const selected = () => pages.filter(page => page.selected);
const active = () => pages.find(page => page.id === activeId);
const currentScope = () => $('exportScope').value === 'all' ? pages : selected();
const checkAbort = signal => { if(signal?.aborted) throw new DOMException('處理已取消。','AbortError'); };

function status(message, percent = null, error = false) {
  $('statusText').textContent = message;
  $('statusArea').dataset.error = String(error);
  $('progress').hidden = percent == null;
  if(percent != null) $('progress').value = Math.max(0,Math.min(100,percent));
}
function syncControls() {
  $('pageCount').textContent = `${pages.length} 頁`;
  $('pageEmpty').hidden = pages.length > 0;
  for(const id of ['selectAll','selectNone']) $(id).disabled = busy || !pages.length;
  $('removeSelected').disabled = busy || !selected().length;
  $('recognizeButton').disabled = busy || !selected().length;
  $('cancelButton').hidden = !busy || !controller;
  for(const id of ['addButton','pasteButton','exampleButton','offlineButton','folderButton','exportScope','wordMode','wordFont','forceOCR']) $(id).disabled = busy;
  for(const button of document.querySelectorAll('[data-export],#exportBoth')) button.disabled = busy || !currentScope().length;
  $('textEditor').disabled = busy || !active()?.recognized;
  $('copyText').disabled = busy || !active()?.recognized;
  $('recognizeButton').textContent = `辨識選取頁面${selected().length ? `（${selected().length}）` : ''}`;
}
function renderList() {
  const list = $('pageList');
  list.replaceChildren();
  pages.forEach((page,index) => {
    const item=document.createElement('li'); item.className=`page-item${page.id===activeId?' active':''}`;
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=page.selected;
    checkbox.disabled=busy;checkbox.setAttribute('aria-label',`選取第 ${index+1} 頁：${page.name}`);
    checkbox.addEventListener('change',()=>{page.selected=checkbox.checked;syncControls();});
    const button=document.createElement('button');button.className='page-button';button.disabled=busy;
    const title=document.createElement('strong');title.textContent=`${index+1}. ${page.name}`;
    const meta=document.createElement('small');meta.textContent=page.recognized ? `${page.lines.length} 行 · ${page.method}` : page.pdf ? 'PDF · 尚未辨識' : '圖片 · 尚未辨識';
    button.append(title,meta);button.addEventListener('click',()=>showPage(page.id).catch(showError));
    item.append(checkbox,button);list.append(item);
  });syncControls();
}
async function pdfLibrary() {
  if(!pdfjs){
    pdfjs=await import('./vendor/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',import.meta.url).href;
  }return pdfjs;
}
function createCanvas(width,height) {
  const canvas=document.createElement('canvas');canvas.width=Math.round(width);canvas.height=Math.round(height);return canvas;
}
const canvasBlob = canvas => new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('圖片暫存失敗，請減少頁面後重試。')),'image/png'));
async function restoreCanvas(blob){
  const image=await createImageBitmap(blob);
  try{const canvas=createCanvas(image.width,image.height);canvas.getContext('2d').drawImage(image,0,0);return canvas;}finally{image.close();}
}
async function releasePage(page){
  // ponytail: compress each completed page; only one page keeps decoded pixels.
  const entries=[[page,'canvas','sourceBlob'],[page,'backgroundCanvas','backgroundBlob'],...(page.analyses?.pictures||[]).map(photo=>[photo,'canvas','canvasBlob'])];
  const canvases=new Set();
  for(const [owner,key,blobKey] of entries)if(owner[key]){
    if(!owner[blobKey])owner[blobKey]=await canvasBlob(owner[key]);
    canvases.add(owner[key]);delete owner[key];
  }
  for(const canvas of canvases){canvas.width=1;canvas.height=1;}
}
async function preparePage(page){
  await ensureCanvas(page);
  if(page.backgroundBlob&&!page.backgroundCanvas)page.backgroundCanvas=await restoreCanvas(page.backgroundBlob);
  for(const photo of page.analyses?.pictures||[])if(photo.canvasBlob&&!photo.canvas)photo.canvas=await restoreCanvas(photo.canvasBlob);
}
async function ensureCanvas(page) {
  if(page.canvas) return page.canvas;
  if(page.sourceBlob){page.canvas=await restoreCanvas(page.sourceBlob);return page.canvas;}
  if(page.pdf){
    const pdfPage=await page.pdf.getPage(page.pdfIndex);
    const original=pdfPage.getViewport({scale:1});
    const scale=Math.min(2.5,3000/Math.max(original.width,original.height));
    const viewport=pdfPage.getViewport({scale});
    const canvas=createCanvas(viewport.width,viewport.height);
    await pdfPage.render({canvasContext:canvas.getContext('2d'),viewport,background:'rgb(255,255,255)'}).promise;
    page.canvas=canvas;page.width=canvas.width;page.height=canvas.height;page.viewport=viewport;
  }else{
    const image=await createImageBitmap(page.file);
    try{
      const scale=Math.min(1,3000/Math.max(image.width,image.height));
      const canvas=createCanvas(Math.max(1,image.width*scale),Math.max(1,image.height*scale));
      const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
      page.canvas=canvas;page.width=canvas.width;page.height=canvas.height;
    }finally{image.close();}
  }return page.canvas;
}
async function showPage(id) {
  const wasBusy=busy;busy=true;
  try {
  activeId=id;renderList();
  const page=active();if(!page)return;
  $('previewName').textContent=page.name;
  $('textEditor').value=page.text ?? '';
  $('resultMeta').textContent=page.recognized ? page.method : '可先校對再匯出';
  $('lineCount').textContent=page.recognized ? `${page.lines.length} 行` : '';
  if(!page.previewURL){await ensureCanvas(page);await releasePage(page);page.previewURL=URL.createObjectURL(page.sourceBlob);}
  if(activeId!==id)return;
  $('previewImage').src=page.previewURL;$('previewImage').hidden=false;$('previewEmpty').hidden=true;
  syncControls();
  } finally {busy=wasBusy;renderList();}
}
function showError(error) {
  console.error(error);
  const message=error?.name==='AbortError' ? '已取消，已完成的辨識結果仍保留。' : error?.message || '處理失敗，請重新加入檔案。';
  status(message,null,error?.name!=='AbortError');
}
async function withBusy(action) {
  if(busy)return;
  busy=true;controller=new AbortController();renderList();
  try{await action(controller.signal);}catch(error){showError(error);}
  finally{controller=null;try{if(active())await showPage(activeId).catch(showError);}finally{busy=false;renderList();}}
}
async function addFiles(files) {
  if(busy)return;
  await withBusy(async signal=>{
    let added=0;const failures=[];
    for(const file of files){
      checkAbort(signal);
      try{
        status(`正在加入：${file.name || '剪貼簿圖片'}`);
        if(file.type==='application/pdf'||/\.pdf$/i.test(file.name)){
          const library=await pdfLibrary();
          const pdf=await library.getDocument({data:await file.arrayBuffer(),cMapUrl:new URL('./vendor/pdfjs/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/pdfjs/standard_fonts/',import.meta.url).href,wasmUrl:new URL('./vendor/pdfjs/wasm/',import.meta.url).href,isEvalSupported:false}).promise;
          for(let number=1;number<=pdf.numPages;number++)pages.push({id:++serial,name:`${file.name} · 第 ${number} 頁`,sourceName:file.name,pdf,pdfIndex:number,selected:true,lines:[],recognized:false,unsaved:true});
          added+=pdf.numPages;
        }else if(file.type.startsWith('image/')||supportedImages.test(file.name)){
          pages.push({id:++serial,name:file.name||`貼上圖片 ${serial}`,sourceName:file.name||'剪貼簿圖片',file,selected:true,lines:[],recognized:false,unsaved:true});added++;
        }else throw new Error('支援 PDF、PNG、JPG、WEBP、BMP 或 GIF。');
      }catch(error){failures.push(`${file.name}：${error.message}`);}
      await yieldUI();
    }
    if(pages.length&&!active())activeId=pages[0].id;
    dirty ||= added>0;
    status(failures.length ? `已加入 ${added} 頁。${failures.join('；')}` : `已加入 ${added} 頁，勾選頁面後即可辨識。`,null,failures.length>0);
  });
}
function loadScript(source){return new Promise((resolve,reject)=>{
  const script=document.createElement('script');script.src=new URL(source,import.meta.url).href;
  script.onload=()=>resolve();script.onerror=()=>reject(new Error('辨識元件下載失敗，請檢查連線後重試。'));document.head.append(script);
});}
async function loadCV(){
  if(!cvLoading)cvLoading=(async()=>{
    await loadScript('./vendor/opencv.js');
    // Legacy OpenCV.then resolves itself. Resolve undefined to avoid assimilation.
    if(!globalThis.cv?.Mat)await new Promise((resolve,reject)=>{if(globalThis.cv?.then)globalThis.cv.then(()=>resolve());else reject(new Error('版面分析元件初始化失敗。'));});
  })().catch(error=>{cvLoading=null;throw error;});
  await cvLoading;
}
async function engine(){
  if(!ocrLoading)ocrLoading=createOCRWorker({modelBase:new URL('./models/',import.meta.url).href,onProgress:progress=>{
    if(progress.stage==='loading')status(progress.message||'首次載入中英文辨識模型…',progress.total?progress.current/progress.total*100:null);
  }}).then(result=>(ocr=result)).catch(error=>{ocrLoading=null;throw error;});
  return ocrLoading;
}
async function pdfText(page){
  const pdfPage=await page.pdf.getPage(page.pdfIndex),content=await pdfPage.getTextContent();
  const library=await pdfLibrary(),scale=page.viewport.scale;
  const items=content.items.filter(item=>item.str?.trim()).map(item=>{
    const t=library.Util.transform(page.viewport.transform,item.transform),height=Math.max(4,Math.hypot(t[2],t[3]));
    return {text:item.str,confidence:1,box:[Math.max(0,t[4]),Math.max(0,t[5]-height),Math.max(2,item.width*scale),height],fontSize:height};
  }).filter(line=>line.box[0]<page.width&&line.box[1]<page.height);
  const text=items.map(line=>line.text).join('');
  if(!text.trim()||((text.match(/[\uFFFD\u0000]/g)||[]).length/text.length)>.02)return [];
  const lines=[];
  for(const item of items){
    const previous=lines.at(-1);
    if(previous&&Math.abs(previous.box[1]-item.box[1])<Math.max(3,item.box[3]*.25)&&item.box[0]>=previous.box[0]&&item.box[0]-previous.box[0]-previous.box[2]<Math.max(10,item.box[3]*1.5)){
      const gap=item.box[0]-previous.box[0]-previous.box[2];previous.text+=(gap>item.box[3]*.4?' ':'')+item.text;previous.box[2]=item.box[0]+item.box[2]-previous.box[0];previous.box[3]=Math.max(previous.box[3],item.box[3]);
    }else lines.push(item);
  }return lines;
}
async function recognizePage(page,signal,force=false){
  checkAbort(signal);await ensureCanvas(page);
  if(!page.recognized||force){
    let lines=[];
    if(page.pdf&&!$('forceOCR').checked)lines=await pdfText(page);
    if(lines.length){page.method='PDF 原有文字';}
    else{const core=await engine();lines=await core.recognize(page.canvas,{signal});page.method=page.pdf?'掃描頁辨識':'圖片辨識';}
    checkAbort(signal);
    page.lines=lines;page.text=lines.map(line=>line.text).join('\n');page.recognized=true;page.analysisDirty=true;page.textEdited=false;
    page.unsaved=true;dirty=true;
  }
}
async function recognizePages(list,signal,force=false){
  for(let index=0;index<list.length;index++){
    checkAbort(signal);const page=list[index];status(`辨識 ${index+1}／${list.length}：${page.name}`,index/list.length*100);
    try{await recognizePage(page,signal,force);}finally{await releasePage(page);}
    renderList();if(activeId===page.id)await showPage(page.id);await yieldUI();
  }
}
async function analyze(page,signal){
  if(!page.analysisDirty&&page.analyses)return;
  await ensureCanvas(page);
  await loadCV();const recognize=async(canvas,options)=> (await engine()).recognize(canvas,options);
  const result=await analyzePage(page,{cv:globalThis.cv,recognize:page.textEdited?null:recognize,signal});
  delete page.backgroundBlob;Object.assign(page,result);page.analysisDirty=false;
}
function editedText(){
  const page=active();if(!page?.recognized)return;
  page.text=$('textEditor').value;const values=page.text.split('\n');
  page.lines.forEach((line,index)=>{line.text=values[index]??'';});
  if(values.length>page.lines.length){
    if(page.lines.length)page.lines.at(-1).text=values.slice(page.lines.length-1).join('\n');
    else page.lines=[{text:page.text,confidence:1,box:[page.width*.05,page.height*.05,page.width*.9,page.height*.9]}];
  }
  page.analysisDirty=true;page.textEdited=true;page.unsaved=true;dirty=true;
  $('resultMeta').textContent='文字已校對';
}
function fileName(kind){
  const now=new Date();
  const stamp=`${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}_${String(now.getMilliseconds()).padStart(3,'0')}`;
  return `辨識結果_${stamp}.${kind}`;
}
async function save(blob,name){
  if(directory){
    const original=name;let suffix=1;
    for(;;){try{await directory.getFileHandle(name);name=original.replace(/(\.[^.]+)$/,`_${suffix++}$1`);}catch(error){if(error.name==='NotFoundError')break;throw error;}}
    const handle=await directory.getFileHandle(name,{create:true});const writer=await handle.createWritable();
    try{await writer.write(blob);await writer.close();}catch(error){await writer.abort().catch(()=>{});throw error;}
  }
  if(downloadURL)URL.revokeObjectURL(downloadURL);
  downloadURL=URL.createObjectURL(blob);const link=$('lastDownload');link.href=downloadURL;link.download=name;link.textContent=`下載：${name}`;link.hidden=false;
  if(!directory){const anchor=document.createElement('a');anchor.href=downloadURL;anchor.download=name;anchor.click();}
}
async function exportKinds(kinds){
  const list=[...currentScope()];if(!list.length)return;
  await withBusy(async signal=>{
    $('exportWarnings').hidden=true;$('exportWarnings').textContent='';
    const imageOnly=kinds.length===1&&kinds[0]==='docx'&&$('wordMode').value==='image';
    if(!imageOnly)await recognizePages(list,signal);
    if(kinds.some(kind=>kind==='xlsx'||kind==='pptx'||kind==='docx'&&$('wordMode').value==='editable')){
      for(let index=0;index<list.length;index++){checkAbort(signal);status(`重建版面 ${index+1}／${list.length}：${list[index].name}`,index/list.length*100);try{await analyze(list[index],signal);}finally{await releasePage(list[index]);}await yieldUI();}
      const issues=list.flatMap(page=>[...new Set(page.analyses?.issues||[])].map(issue=>`第 ${pages.indexOf(page)+1} 頁：${issue}`));
      $('exportWarnings').textContent=issues.join('　');$('exportWarnings').hidden=!issues.length;
    }
    const bundle=kinds.length>1&&!directory ? new globalThis.JSZip() : null;
    for(const kind of kinds){
      checkAbort(signal);status(`正在建立 ${kind.toUpperCase()}（${list.length} 頁）…`,0);
      const blob=await exportDocument(kind,list,{mode:$('wordMode').value,wordFont:$('wordFont').value,preparePage:async page=>{checkAbort(signal);await preparePage(page);},releasePage,onProgress:progress=>{if(progress.phase==='zip')status(`正在打包 ${kind.toUpperCase()}…`,progress.percent);}});
      checkAbort(signal);const name=fileName(kind);
      if(bundle)bundle.file(name,await blob.arrayBuffer());else await save(blob,name);
    }
    if(bundle){status('正在打包 Word 與 Excel…');const packed=await bundle.generateAsync({type:'blob'});checkAbort(signal);await save(packed,fileName('zip'));}
    status(directory?`已匯出 ${list.length} 頁，存放在「${directory.name}」。`:`已建立 ${list.length} 頁，若尚未下載請點下方下載連結。`);
    list.forEach(page=>page.unsaved=false);dirty=pages.some(page=>page.unsaved);
  });
}
async function pasteClipboard(){
  if(!navigator.clipboard?.read)throw new Error('請在頁面空白處按 Ctrl+V 貼上圖片。');
  const files=[];
  for(const item of await navigator.clipboard.read())for(const type of item.types.filter(type=>type.startsWith('image/'))){const blob=await item.getType(type);files.push(new File([blob],`貼上圖片_${serial+files.length+1}.png`,{type}));break;}
  if(!files.length)throw new Error('剪貼簿裡沒有圖片。截圖或複製圖片後再貼上。');
  await addFiles(files);
}
$('addButton').addEventListener('click',()=>$('fileInput').click());
$('fileInput').addEventListener('change',async()=>{const files=Array.from($('fileInput').files);$('fileInput').value='';await addFiles(files);});
$('pasteButton').addEventListener('click',()=>pasteClipboard().catch(error=>{status(error.name==='NotAllowedError'?'請在頁面空白處按 Ctrl+V，或允許瀏覽器讀取剪貼簿。':error.message,null,true);}));
document.addEventListener('paste',event=>{
  if(busy||event.target.matches('textarea,input[type="text"]'))return;
  const files=Array.from(event.clipboardData?.items||[]).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
  if(files.length){event.preventDefault();addFiles(files).catch(showError);}
});
let dragDepth=0;
document.addEventListener('dragenter',event=>{if(Array.from(event.dataTransfer?.types||[]).includes('Files')){event.preventDefault();dragDepth++;$('dropZone').classList.add('dragging');}});
document.addEventListener('dragover',event=>{if(Array.from(event.dataTransfer?.types||[]).includes('Files'))event.preventDefault();});
document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('dropZone').classList.remove('dragging');}});
document.addEventListener('drop',event=>{if(event.dataTransfer?.files.length){event.preventDefault();dragDepth=0;$('dropZone').classList.remove('dragging');addFiles(Array.from(event.dataTransfer.files)).catch(showError);}});
$('selectAll').addEventListener('click',()=>{pages.forEach(page=>page.selected=true);renderList();});
$('selectNone').addEventListener('click',()=>{pages.forEach(page=>page.selected=false);renderList();});
$('removeSelected').addEventListener('click',async()=>{
  const removed=selected();removed.forEach(page=>{if(page.previewURL)URL.revokeObjectURL(page.previewURL);if(page.canvas){page.canvas.width=0;page.canvas.height=0;}});
  for(let index=pages.length-1;index>=0;index--)if(pages[index].selected)pages.splice(index,1);
  dirty=pages.some(page=>page.unsaved);
  for(const pdf of new Set(removed.map(page=>page.pdf).filter(Boolean)))if(!pages.some(page=>page.pdf===pdf))await pdf.destroy();
  if(!active())activeId=pages[0]?.id??null;
  if(active())await showPage(activeId);else{$('previewImage').hidden=true;$('previewImage').removeAttribute('src');$('previewEmpty').hidden=false;$('previewName').textContent='尚未選擇頁面';$('textEditor').value='';$('resultMeta').textContent='可先校對再匯出';$('lineCount').textContent='';}
  renderList();status(`已從本次工作移除 ${removed.length} 頁。`);
});
$('recognizeButton').addEventListener('click',()=>withBusy(async signal=>{await recognizePages([...selected()],signal,true);status(`已完成 ${selected().length} 頁辨識，可校對文字或匯出文件。`);}));
$('cancelButton').addEventListener('click',()=>{controller?.abort();status('正在取消，已完成的頁面會保留…');});
$('textEditor').addEventListener('input',editedText);
$('copyText').addEventListener('click',()=>navigator.clipboard.writeText($('textEditor').value).then(()=>status('已複製此頁文字。')).catch(()=>status('請選取文字後按 Ctrl+C 複製。',null,true)));
$('exportScope').addEventListener('change',syncControls);
document.querySelectorAll('[data-export]').forEach(button=>button.addEventListener('click',()=>exportKinds([button.dataset.export])));
$('exportBoth').addEventListener('click',()=>exportKinds(['docx','xlsx']));
$('folderButton').addEventListener('click',async()=>{
  if(!window.showDirectoryPicker){status('此瀏覽器使用一般下載；可在下載設定選擇每次詢問儲存位置。');return;}
  try{directory=await window.showDirectoryPicker({mode:'readwrite',id:'textocr-output'});$('folderLabel').textContent=`存放在：${directory.name}`;status('已設定儲存資料夾，後續輸出會寫入這裡。');}
  catch(error){if(error.name!=='AbortError')showError(error);}
});
$('exampleButton').addEventListener('click',async()=>{
  try{const response=await fetch('./examples/中英測試.png');if(!response.ok)throw new Error('範例下載失敗。');await addFiles([new File([await response.blob()],'中英測試.png',{type:'image/png'})]);}catch(error){showError(error);}
});
$('manualButton').addEventListener('click',()=>$('manualDialog').showModal());
$('closeManual').addEventListener('click',()=>$('manualDialog').close());
$('offlineButton').addEventListener('click',()=>withBusy(async()=>{
  if(!workerRegistration)throw new Error('此開啟方式不支援離線快取，請使用正式 HTTPS 網址。');
  const serviceWorker=workerRegistration.active||workerRegistration.waiting||workerRegistration.installing;
  if(!serviceWorker)throw new Error('離線元件尚未就緒，請稍後重試。');
  await new Promise((resolve,reject)=>{
    const channel=new MessageChannel();channel.port1.onmessage=event=>{const data=event.data;if(data.error){channel.port1.close();reject(new Error(data.error));}else if(data.done){channel.port1.close();resolve();}else status(`準備離線資源 ${data.current}／${data.total}…`,data.current/data.total*100);};
    serviceWorker.postMessage({type:'CACHE_ALL'},[channel.port2]);
  });$('offlineState').textContent='已準備離線使用';status('離線資源已保存，可用同一瀏覽器再次開啟這個網址。');
}));
window.addEventListener('beforeunload',event=>{if(dirty&&pages.length){event.preventDefault();event.returnValue='';}});
if('serviceWorker' in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').then(async registration=>{workerRegistration=registration;await navigator.serviceWorker.ready;$('offlineState').textContent='可點「準備離線使用」保存模型與網站';}).catch(()=>{$('offlineState').textContent='目前使用線上模式';});
syncControls();
