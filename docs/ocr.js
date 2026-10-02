/* PP-OCRv5 mobile browser pipeline, ported from RapidOCR 3.9.2 (Apache-2.0).
 * Copyright (c) 2020 PaddlePaddle Authors. All Rights Reserved.
 * RapidOCR contributors: SWHL and RapidAI.
 * Licensed under the Apache License, Version 2.0:
 * https://www.apache.org/licenses/LICENSE-2.0
 * Distributed on an AS IS BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
 * Source: https://github.com/RapidAI/RapidOCR/tree/v3.9.2/python/rapidocr
 * Runtime: https://onnxruntime.ai/docs/get-started/with-javascript/web.html
 * OpenCV: https://docs.opencv.org/4.x/dd/d52/tutorial_js_geometric_transformations.html
 * Images stay in this browser. Only the packaged models are fetched.
 */

const DET_MEAN = [.485, .456, .406], DET_STD = [.229, .224, .225];
const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// NumPy uses nearest-even rounding, including when resize dimensions hit x.5.
function roundEven(value) {
  const floor = Math.floor(value), fraction = value - floor;
  return fraction === .5 ? floor + (floor % 2 === 0 ? 0 : 1) : Math.round(value);
}

export function detectorDimensions(width, height) {
  const longest = Math.max(width, height);
  const limit = longest < 960 ? 960 : longest < 1500 ? 1500 : 2000;
  const ratio = Math.min(1, limit / longest);
  return [Math.max(32, roundEven(Math.trunc(width * ratio) / 32) * 32),
          Math.max(32, roundEven(Math.trunc(height * ratio) / 32) * 32)];
}

// BGR matches RapidOCR's LoadImage(PIL image), not RGB/ImageNet convention.
export function normalizeBGR(bytes, width, height, mode = 'rec', paddedWidth = width) {
  if (!['det', 'rec', 'cls'].includes(mode) || paddedWidth < width || bytes.length !== width * height * 3) {
    throw new Error('OCR image tensor dimensions are invalid.');
  }
  const output = new Float32Array(3 * height * paddedWidth);
  for (let channel = 0; channel < 3; channel++) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const input = bytes[(y * width + x) * 3 + channel];
      const scaled = mode === 'det' ? Math.fround(input * Math.fround(1 / 255)) : Math.fround(input / 255);
      output[channel * height * paddedWidth + y * paddedWidth + x] = mode === 'det'
        ? (scaled - DET_MEAN[channel]) / DET_STD[channel]
        : Math.fround(Math.fround(scaled - .5) / .5);
    }
  }
  return output;
}

export function decodeCTC(data, shape, dictionary) {
  const [batch, steps, classes] = shape;
  if (shape.length !== 3 || classes !== dictionary.length || data.length !== batch * steps * classes) {
    throw new Error('OCR model and character dictionary do not match.');
  }
  const results = [];
  for (let b = 0; b < batch; b++) {
    let previous = -1, text = '', sum = 0, count = 0;
    for (let step = 0; step < steps; step++) {
      const offset = (b * steps + step) * classes;
      let best = 0, confidence = data[offset];
      for (let i = 1; i < classes; i++) if (data[offset + i] > confidence) {
        best = i; confidence = data[offset + i];
      }
      if (best !== 0 && best !== previous) {
        text += dictionary[best];
        sum += roundEven(confidence * 1e5) / 1e5; count++;
      }
      previous = best;
    }
    results.push({text, confidence: count ? roundEven(sum / count * 1e5) / 1e5 : 0});
  }
  return results;
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new DOMException('辨識已取消。', 'AbortError');
}

function orderQuad(points) {
  const sorted = points.slice().sort((a, b) => a[0] - b[0]);
  const left = sorted.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const right = sorted.slice(2).sort((a, b) => a[1] - b[1]);
  return [left[0], right[0], right[1], left[1]];
}

function miniBox(cv, contour) {
  const rectangle = cv.minAreaRect(contour);
  const radians = rectangle.angle * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const corners = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x, y]) => {
    x *= rectangle.size.width / 2; y *= rectangle.size.height / 2;
    return [rectangle.center.x + x * cos - y * sin,
            rectangle.center.y + x * sin + y * cos];
  });
  return {points: orderQuad(corners), shortSide: Math.min(rectangle.size.width, rectangle.size.height)};
}

function boxScore(cv, probabilities, width, height, points) {
  const xmin = clamp(Math.floor(Math.min(...points.map(p => p[0]))), 0, width - 1);
  const xmax = clamp(Math.ceil(Math.max(...points.map(p => p[0]))), 0, width - 1);
  const ymin = clamp(Math.floor(Math.min(...points.map(p => p[1]))), 0, height - 1);
  const ymax = clamp(Math.ceil(Math.max(...points.map(p => p[1]))), 0, height - 1);
  const localWidth = xmax - xmin + 1, localHeight = ymax - ymin + 1;
  const mask = cv.Mat.zeros(localHeight, localWidth, cv.CV_8UC1);
  const polygon = cv.matFromArray(4, 1, cv.CV_32SC2, points.flatMap(p => [Math.trunc(p[0] - xmin), Math.trunc(p[1] - ymin)]));
  const polygons = new cv.MatVector();
  try {
    polygons.push_back(polygon);
    cv.fillPoly(mask, polygons, new cv.Scalar(1));
    let sum = 0, count = 0;
    for (let y = 0; y < localHeight; y++) for (let x = 0; x < localWidth; x++) {
      if (mask.data[y * localWidth + x]) {
        sum += probabilities[(ymin + y) * width + xmin + x]; count++;
      }
    }
    return count ? sum / count : 0;
  } finally {polygons.delete(); polygon.delete(); mask.delete();}
}

function unclip(ClipperLib, points) {
  let area = 0, perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += a[0] * b[1] - a[1] * b[0]; perimeter += distance(a, b);
  }
  if (!perimeter) return [];
  const delta = Math.abs(area) / 2 * 1.6 / perimeter;
  const offset = new ClipperLib.ClipperOffset();
  offset.AddPath(points.map(p => ({X: Math.trunc(p[0]), Y: Math.trunc(p[1])})),
                 ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const paths = new ClipperLib.Paths();
  offset.Execute(paths, delta);
  return paths.flatMap(path => path.map(p => [p.X, p.Y]));
}

function detectorBoxes(cv, ClipperLib, prediction, sourceWidth, sourceHeight) {
  const height = prediction.dims.at(-2), width = prediction.dims.at(-1);
  if (prediction.dims.length !== 4 || prediction.dims[0] !== 1 || prediction.dims[1] !== 1) {
    throw new Error('Unexpected PP-OCRv5 detector output.');
  }
  const bitmap = new cv.Mat(height, width, cv.CV_8UC1);
  const kernel = cv.Mat.ones(2, 2, cv.CV_8UC1), dilated = new cv.Mat();
  const contours = new cv.MatVector(), hierarchy = new cv.Mat();
  try {
    for (let i = 0; i < width * height; i++) bitmap.data[i] = prediction.data[i] > .3 ? 255 : 0;
    cv.dilate(bitmap, dilated, kernel);
    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const boxes = [];
    for (let i = 0; i < Math.min(contours.size(), 1000); i++) {
      const contour = contours.get(i);
      try {
        const first = miniBox(cv, contour);
        if (first.shortSide < 3) continue;
        const confidence = boxScore(cv, prediction.data, width, height, first.points);
        if (confidence < .5) continue;
        const expanded = unclip(ClipperLib, first.points);
        if (!expanded.length) continue;
        const expandedMat = cv.matFromArray(expanded.length, 1, cv.CV_32SC2, expanded.flat());
        let second;
        try {second = miniBox(cv, expandedMat);} finally {expandedMat.delete();}
        if (second.shortSide < 5) continue;
        const polygon = orderQuad(second.points.map(p => [
          clamp(roundEven(p[0] / width * sourceWidth), 0, sourceWidth - 1),
          clamp(roundEven(p[1] / height * sourceHeight), 0, sourceHeight - 1)]));
        if (Math.trunc(distance(polygon[0], polygon[1])) <= 3 || Math.trunc(distance(polygon[0], polygon[3])) <= 3) continue;
        boxes.push({polygon, confidence});
      } finally {contour.delete();}
    }
    // RapidOCR's stable y sort, adjacent rows >=10px start a new line, then x sort.
    boxes.sort((a, b) => a.polygon[0][1] - b.polygon[0][1]);
    let row = 0, lastY = null;
    for (const box of boxes) {
      const y = box.polygon[0][1];
      if (lastY !== null && y - lastY >= 10) row++;
      box.row = row; lastY = y;
    }
    return boxes.sort((a, b) => a.row - b.row || a.polygon[0][0] - b.polygon[0][0]);
  } finally {hierarchy.delete(); contours.delete(); dilated.delete(); kernel.delete(); bitmap.delete();}
}

function perspectiveCrop(cv, source, polygon) {
  const width = Math.max(1, Math.trunc(Math.max(distance(polygon[0], polygon[1]), distance(polygon[2], polygon[3]))));
  const height = Math.max(1, Math.trunc(Math.max(distance(polygon[0], polygon[3]), distance(polygon[1], polygon[2]))));
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, polygon.flat());
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0,0,width,0,width,height,0,height]);
  const transform = cv.getPerspectiveTransform(src, dst), image = new cv.Mat();
  try {
    cv.warpPerspective(source, image, transform, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    if (height / width >= 1.5) {
      const rotated = new cv.Mat();
      try {cv.rotate(image, rotated, cv.ROTATE_90_COUNTERCLOCKWISE);} catch (error) {rotated.delete(); throw error;}
      image.delete(); return rotated;
    }
    return image;
  } catch (error) {image.delete(); throw error;}
  finally {transform.delete(); dst.delete(); src.delete();}
}

function resizeTensor(cv, image, mode, outputWidth) {
  const height = mode === 'cls' ? 80 : 48;
  const width = Math.min(outputWidth, Math.ceil(height * image.cols / image.rows));
  const resized = new cv.Mat();
  try {
    cv.resize(image, resized, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR);
    return normalizeBGR(resized.data, width, height, mode, outputWidth);
  } finally {resized.delete();}
}

function validateCanvas(canvas) {
  const width = canvas.width, height = canvas.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > 64_000_000) {
    throw new Error('圖片尺寸無效或過大，請先縮小或裁切圖片。');
  }
}

function imageMat(cv, canvas) {
  validateCanvas(canvas);
  const width = canvas.width, height = canvas.height;
  const context = canvas.getContext('2d', {willReadFrequently: true});
  if (!context) throw new Error('無法讀取圖片畫布。');
  const pixels = context.getImageData(0, 0, width, height);
  // PIL's existing pipeline composites transparent pixels over white.
  for (let i = 0; i < pixels.data.length; i += 4) {
    const alpha = pixels.data[i + 3] / 255;
    if (alpha < 1) for (let c = 0; c < 3; c++) pixels.data[i + c] = roundEven(pixels.data[i + c] * alpha + 255 * (1 - alpha));
    pixels.data[i + 3] = 255;
  }
  const rgba = cv.matFromImageData(pixels), bgr = new cv.Mat();
  try {cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR); return bgr;}
  catch (error) {bgr.delete(); throw error;}
  finally {rgba.delete();}
}

function prepareImage(cv, source) {
  const originalWidth = source.cols, originalHeight = source.rows;
  let width = originalWidth, height = originalHeight;
  if (Math.max(width, height) > 3000 || Math.min(width, height) < 30) {
    const ratio = Math.max(width, height) > 3000 ? 3000 / Math.max(width, height) : 30 / Math.min(width, height);
    width = Math.max(32, roundEven(Math.trunc(width * ratio) / 32) * 32);
    height = Math.max(32, roundEven(Math.trunc(height * ratio) / 32) * 32);
  }
  let image = new cv.Mat();
  try {
    cv.resize(source, image, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR);
    const padding = height <= 30 || width / height > 8 ? Math.trunc(Math.abs(Math.max(Math.trunc(width / 8), 30) * 2 - height) / 2) : 0;
    if (padding) {
      const padded = new cv.Mat();
      try {cv.copyMakeBorder(image, padded, padding, padding, 0, 0, cv.BORDER_CONSTANT, new cv.Scalar(0,0,0));}
      catch (error) {padded.delete(); throw error;}
      image.delete(); image = padded;
    }
    return {image, padding, scaleX: originalWidth / width, scaleY: originalHeight / height};
  } catch (error) {image.delete(); throw error;}
}

async function checkedAsset(base, entry, description) {
  if (!entry || !/^[a-zA-Z0-9_.-]+$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error(`辨識模型清單無效：${description}`);
  }
  const response = await fetch(new URL(entry.file, base));
  if (!response.ok) throw new Error(`無法載入 ${description}（HTTP ${response.status}），請重新整理網頁。`);
  const data = await response.arrayBuffer();
  if (data.byteLength !== entry.bytes) throw new Error(`${description} 檔案不完整。`);
  if (!globalThis.crypto?.subtle) throw new Error('請使用 HTTPS 或本機 localhost 開啟此網頁。');
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== entry.sha256) throw new Error(`${description} 校驗失敗，請重新下載網站資料。`);
  return new Uint8Array(data);
}

export async function createOCR({onProgress = () => {}, modelBase = './models/', cv = globalThis.cv,
                                  ort = globalThis.ort, clipper = globalThis.ClipperLib} = {}) {
  // Official OpenCV 4.13 exposes a self-returning legacy thenable. Awaiting that
  // object directly repeatedly assimilates itself and freezes the event loop.
  if (!cv?.Mat && typeof cv?.then === 'function') {
    let ready;
    await new Promise((resolve, reject) => cv.then(value => {ready = value; resolve();}, reject));
    cv = ready;
  }
  if (!cv?.Mat || !ort?.InferenceSession || !clipper?.ClipperOffset) {
    throw new Error('辨識元件尚未載入，請稍候或重新整理網頁。');
  }
  const base = new URL(modelBase, globalThis.document?.baseURI || import.meta.url);
  const manifestResponse = await fetch(new URL('manifest.json', base));
  if (!manifestResponse.ok) throw new Error('無法載入辨識模型清單。');
  const manifest = await manifestResponse.json(), sessions = {};
  let dictionary, disposed = false, busy = false;
  try {
    for (const [index, task] of ['det', 'cls', 'rec', 'dict'].entries()) {
      onProgress({stage: 'loading', current: index, total: 4, message: `載入辨識模型 ${index + 1}/4`});
      const data = await checkedAsset(base, manifest[task], task === 'dict' ? '中文字典' : `${task} 模型`);
      if (task === 'dict') dictionary = JSON.parse(new TextDecoder().decode(data));
      else sessions[task] = await ort.InferenceSession.create(data, {executionProviders: ['wasm'], graphOptimizationLevel: 'all'});
    }
    if (!Array.isArray(dictionary) || dictionary.length !== 18385 || dictionary[0] !== 'blank' || dictionary.at(-1) !== ' ') {
      throw new Error('PP-OCRv5 中文字典不完整。');
    }
  } catch (error) {
    await Promise.allSettled(Object.values(sessions).map(session => session.release()));
    throw error;
  }
  onProgress({stage: 'ready', current: 4, total: 4, message: '中英文辨識模型已就緒'});

  async function run(task, data, dims) {
    const tensor = new ort.Tensor('float32', data, dims);
    try {
      const output = await sessions[task].run({[sessions[task].inputNames[0]]: tensor});
      return output[sessions[task].outputNames[0]];
    } finally {tensor.dispose?.();}
  }

  async function recognize(canvas, {signal} = {}) {
    abortIfNeeded(signal);
    if (disposed) throw new Error('辨識引擎已關閉。');
    if (busy) throw new Error('請等待目前圖片辨識完成。');
    busy = true;
    let original, prepared;
    const crops = [];
    try {
      original = imageMat(cv, canvas); prepared = prepareImage(cv, original);
      const image = prepared.image, [detWidth, detHeight] = detectorDimensions(image.cols, image.rows);
      onProgress({stage: 'detect', current: 0, total: 1, message: '尋找文字位置'});
      await yieldUI(); abortIfNeeded(signal);
      const resized = new cv.Mat();
      let input;
      try {cv.resize(image, resized, new cv.Size(detWidth, detHeight), 0, 0, cv.INTER_LINEAR); input = normalizeBGR(resized.data, detWidth, detHeight, 'det');}
      finally {resized.delete();}
      const prediction = await run('det', input, [1, 3, detHeight, detWidth]);
      let boxes;
      try {abortIfNeeded(signal); boxes = detectorBoxes(cv, clipper, prediction, image.cols, image.rows);}
      finally {prediction.dispose?.();}
      if (!boxes.length) return [];
      for (const box of boxes) {abortIfNeeded(signal); crops.push(perspectiveCrop(cv, image, box.polygon));}
      const indices = crops.map((crop, index) => ({index, ratio: crop.cols / crop.rows})).sort((a, b) => a.ratio - b.ratio).map(item => item.index);
      for (let start = 0; start < indices.length; start += 6) {
        const batchIndices = indices.slice(start, start + 6), data = new Float32Array(batchIndices.length * 3 * 80 * 160);
        batchIndices.forEach((index, i) => data.set(resizeTensor(cv, crops[index], 'cls', 160), i * 3 * 80 * 160));
        abortIfNeeded(signal);
        const result = await run('cls', data, [batchIndices.length, 3, 80, 160]);
        try {
          abortIfNeeded(signal);
          batchIndices.forEach((index, i) => {
            if (result.data[i * 2 + 1] > result.data[i * 2] && result.data[i * 2 + 1] > .9) {
              const rotated = new cv.Mat();
              try {cv.rotate(crops[index], rotated, cv.ROTATE_180);} catch (error) {rotated.delete(); throw error;}
              crops[index].delete(); crops[index] = rotated;
            }
          });
        } finally {result.dispose?.();}
        await yieldUI();
      }
      const results = new Array(boxes.length);
      for (let start = 0; start < indices.length; start += 6) {
        const batchIndices = indices.slice(start, start + 6);
        const width = Math.trunc(48 * Math.max(320 / 48, ...batchIndices.map(index => crops[index].cols / crops[index].rows)));
        const data = new Float32Array(batchIndices.length * 3 * 48 * width);
        batchIndices.forEach((index, i) => data.set(resizeTensor(cv, crops[index], 'rec', width), i * 3 * 48 * width));
        abortIfNeeded(signal);
        const result = await run('rec', data, [batchIndices.length, 3, 48, width]);
        try {
          abortIfNeeded(signal);
          decodeCTC(result.data, result.dims, dictionary).forEach((line, i) => {results[batchIndices[i]] = line;});
        } finally {result.dispose?.();}
        onProgress({stage: 'recognize', current: Math.min(start + 6, indices.length), total: indices.length,
                    message: `辨識文字 ${Math.min(start + 6, indices.length)}/${indices.length}`});
        await yieldUI();
      }
      return results.map((result, index) => {
        const polygon = boxes[index].polygon.map(([x,y]) => [
          clamp(x * prepared.scaleX, 0, original.cols),
          clamp((y - prepared.padding) * prepared.scaleY, 0, original.rows)]);
        const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
        return {...result, polygon, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]};
      }).filter(result => result.text && result.confidence >= .5);
    } finally {for (const crop of crops) crop.delete(); prepared?.image.delete(); original?.delete(); busy = false;}
  }

  async function dispose() {
    if (busy) throw new Error('請先取消或等待辨識完成，再關閉引擎。');
    if (!disposed) {disposed = true; await Promise.allSettled(Object.values(sessions).map(session => session.release()));}
  }
  return {recognize, dispose};
}

// Same engine interface, with CV and inference in a dedicated worker so pasting,
// previews and Cancel remain responsive while large pages are processed.
export async function createOCRWorker({onProgress = () => {}, modelBase = './models/'} = {}) {
  if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    throw new Error('此瀏覽器不支援背景辨識，請使用新版 Chrome 或 Edge。');
  }
  const worker = new Worker(new URL('./ocr.worker.js', import.meta.url));
  const pending = new Map();
  let nextId = 0, disposed = false, busy = false;
  function failAll(error) {for (const request of pending.values()) request.reject(error); pending.clear();}
  worker.onerror = event => {disposed = true; failAll(new Error(event.message || '背景辨識無法啟動。')); worker.terminate();};
  worker.onmessage = ({data}) => {
    if (data.type === 'progress') {onProgress(data.progress); return;}
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.type === 'error') {
      const error = new Error(data.error.message); error.name = data.error.name; request.reject(error);
    } else request.resolve(data.result);
  };
  function request(type, extra = {}, transfer = [], signal) {
    if (disposed) return Promise.reject(new Error('辨識引擎已關閉。'));
    const id = ++nextId;
    let removeAbort = () => {};
    const promise = new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      if (signal) {
        const cancel = () => worker.postMessage({type: 'cancel', id});
        signal.addEventListener('abort', cancel, {once: true});
        removeAbort = () => signal.removeEventListener('abort', cancel);
      }
      try {worker.postMessage({id, type, ...extra}, transfer);}
      catch (error) {pending.delete(id); reject(error);}
      if (signal?.aborted) worker.postMessage({type: 'cancel', id});
    });
    return promise.finally(removeAbort);
  }
  try {
    const modelURL = new URL(modelBase, globalThis.document?.baseURI || import.meta.url).href;
    await request('initialize', {modelBase: modelURL});
  } catch (error) {disposed = true; worker.terminate(); throw error;}
  return {
    async recognize(canvas, {signal} = {}) {
      abortIfNeeded(signal);
      validateCanvas(canvas);
      if (disposed) throw new Error('辨識引擎已關閉。');
      if (busy) throw new Error('請等待目前圖片辨識完成。');
      busy = true;
      let bitmap;
      try {
        bitmap = await createImageBitmap(canvas);
        abortIfNeeded(signal);
        return await request('recognize', {bitmap}, [bitmap], signal);
      } finally {bitmap?.close(); busy = false;}
    },
    async dispose() {
      if (busy) throw new Error('請先取消或等待辨識完成，再關閉引擎。');
      if (!disposed) {
        try {await request('dispose');}
        finally {disposed = true; worker.terminate(); failAll(new Error('辨識引擎已關閉。'));}
      }
    },
  };
}
