/* Dedicated local OCR worker. No image requests or server-side inference. */
importScripts('./vendor/opencv.js', './vendor/clipper.js', './vendor/ort.wasm.min.js');
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL('./vendor/', self.location.href).href;

let engine, active, activeId;
self.onmessage = async ({data}) => {
  const {id, type} = data;
  if (type === 'cancel') {
    if (activeId === id) active?.abort();
    return;
  }
  try {
    if (type === 'initialize') {
      if (engine) throw new Error('辨識引擎已啟動。');
      const {createOCR} = await import('./ocr.js');
      engine = await createOCR({cv: self.cv, ort: self.ort, clipper: self.ClipperLib,
        modelBase: data.modelBase || './models/',
        onProgress: progress => self.postMessage({id: activeId ?? id, type: 'progress', progress})});
      self.postMessage({id, type: 'result', result: null});
    } else if (type === 'recognize') {
      if (!engine) throw new Error('辨識引擎尚未就緒。');
      if (active) throw new Error('請等待目前圖片辨識完成。');
      active = new AbortController(); activeId = id;
      const bitmap = data.bitmap;
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d', {willReadFrequently: true}).drawImage(bitmap, 0, 0);
        bitmap.close();
        const result = await engine.recognize(canvas, {signal: active.signal});
        self.postMessage({id, type: 'result', result});
      } finally {bitmap.close(); active = null; activeId = null;}
    } else if (type === 'dispose') {
      await engine?.dispose(); engine = null;
      self.postMessage({id, type: 'result', result: null});
    } else throw new Error('無效的辨識請求。');
  } catch (error) {
    self.postMessage({id, type: 'error', error: {name: error.name || 'Error', message: error.message || String(error)}});
  }
};
