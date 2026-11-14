'use strict';
/* Détourage 100 % local.
   - « auto »     : U²-Netp (sujet principal : personne, animal, objet ; Apache-2.0), ~4,6 Mo
   - « fond uni » : remplissage depuis les bords, sans IA
   Inférence : onnxruntime-web (WebAssembly). */
const BG = (() => {
  let ortPromise = null;
  const sessions = {};

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('impossible de charger ' + src));
      document.head.append(s);
    });
  }
  function ortReady() {
    if (!ortPromise) {
      ortPromise = (async () => {
        if (!window.ort) await loadScript('vendor/ort/ort.wasm.min.js');
        ort.env.wasm.wasmPaths = new URL('vendor/ort/', location.href).href;
        ort.env.wasm.numThreads = 1;
      })().catch((e) => { ortPromise = null; throw e; });
    }
    return ortPromise;
  }
  async function session(file) {
    await ortReady();
    if (!sessions[file]) {
      sessions[file] = ort.InferenceSession.create('models/bg/' + file, { executionProviders: ['wasm'] })
        .catch((e) => { delete sessions[file]; throw e; });
    }
    return sessions[file];
  }

  function pixels(src, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  }
  function toTensor(data, w, h, mean, std) {
    const n = w * h, f = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) f[c * n + i] = (data[i * 4 + c] / 255 - mean[c]) / std[c];
    }
    return new ort.Tensor('float32', f, [1, 3, h, w]);
  }

  async function maskObject(src) {
    const s = await session('u2netp.onnx');
    const w = 320, h = 320;
    const out = await s.run({ [s.inputNames[0]]: toTensor(pixels(src, w, h), w, h, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]) });
    const m = out[s.outputNames[0]].data;
    let mn = Infinity, mx = -Infinity;
    for (const v of m) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const d = new Float32Array(m.length), span = mx - mn || 1;
    for (let i = 0; i < m.length; i++) d[i] = (m[i] - mn) / span;
    return { data: d, w, h };
  }

  // Fond uni : on part de la couleur dominante des bords et on remplit tout ce qui y est relié.
  function maskFlat(src, tolerance) {
    const k = Math.min(1, 640 / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
    const px = pixels(src, w, h);
    const border = [[], [], []];
    const pushB = (i) => { for (let c = 0; c < 3; c++) border[c].push(px[i * 4 + c]); };
    for (let x = 0; x < w; x++) { pushB(x); pushB((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { pushB(y * w); pushB(y * w + w - 1); }
    const med = border.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);
    const tol = tolerance * 4.4, tol2 = tol * tol;
    const near = (i) => {
      const r = px[i * 4] - med[0], g = px[i * 4 + 1] - med[1], b = px[i * 4 + 2] - med[2];
      return r * r + g * g + b * b <= tol2;
    };
    const bg = new Uint8Array(w * h);
    const stack = [];
    const seed = (i) => { if (!bg[i] && near(i)) { bg[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      if (x > 0) seed(i - 1);
      if (x < w - 1) seed(i + 1);
      if (y > 0) seed(i - w);
      if (y < h - 1) seed(i + w);
    }
    // adoucit le bord (flou 3×3)
    const d = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += bg[yy * w + xx] ? 0 : 1; n++; }
      }
      d[y * w + x] = s / n;
    }
    return { data: d, w, h };
  }

  function applyMask(src, mask) {
    const m = document.createElement('canvas');
    m.width = mask.w; m.height = mask.h;
    const mctx = m.getContext('2d');
    const img = mctx.createImageData(mask.w, mask.h);
    for (let i = 0; i < mask.data.length; i++) {
      // resserre le masque : supprime les zones « fantômes » à moitié transparentes
      const a = Math.max(0, Math.min(1, (mask.data[i] - 0.2) / 0.6));
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = Math.round(a * 255);
    }
    mctx.putImageData(img, 0, 0);
    const out = document.createElement('canvas');
    out.width = src.width; out.height = src.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(m, 0, 0, src.width, src.height);
    return out;
  }

  async function cut(src, mode, tolerance = 30) {
    let mask;
    if (mode === 'auto') mask = await maskObject(src);
    else if (mode === 'flat') mask = maskFlat(src, tolerance);
    else return src;
    return applyMask(src, mask);
  }

  return { cut };
})();
