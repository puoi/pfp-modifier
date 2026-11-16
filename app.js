'use strict';
/* PFP Modifier — tout tourne dans le navigateur (face-api / TensorFlow.js). */

const MODEL_URL = 'models';
const PREVIEW_SIDE = 1600;      // taille de travail pour détection et aperçus
const MAX_PIXELS = 16_000_000;  // limite de surface canvas (iOS)

const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
let uidCounter = 0;
const nid = (p) => p + (++uidCounter);

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}

const state = {
  photos: [],   // {id, file, name, w, h, thumb, previewBlob, previewUrl, ready, processed, error}
  faces: [],    // {id, photoId, box:{x,y,w,h} (px originaux), angle, desc, thumb, groupId}
  groups: [],   // {id, name, replId}
  repls: [],    // {id, file, name, thumb, src(canvas), face:{cx,cy,size,angle}|null, useFace, ready, error}
  selected: new Set(),
  threshold: 0.52,
  settings: { shape: 'ellipse', scale: 1.4, rotate: true, outline: false },
  results: new Map(), // photoId -> {sig, url}
  busy: false,
};
let groupCounter = 0;

/* ---------- Modèles ---------- */
let modelsPromise = null;
function loadModels() {
  if (!modelsPromise) {
    modelsPromise = (async () => {
      setStatus('Chargement des modèles de reconnaissance (≈12 Mo, une seule fois)…', null);
      try { await faceapi.tf.setBackend('webgl'); } catch (e) { /* repli CPU */ }
      await faceapi.tf.ready();
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);
    })().catch((err) => { modelsPromise = null; throw err; });
  }
  return modelsPromise;
}

/* ---------- Images ---------- */
function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve(Object.assign(img, { _url: url }));
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('format illisible')); };
    img.src = url;
  });
}
function freeImage(img) { URL.revokeObjectURL(img._url); img.removeAttribute('src'); }

function fitCanvas(src, w, h, maxSide) {
  let k = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function toBlob(canvas, type = 'image/jpeg', q = 0.92) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('export impossible'))), type, q));
}
function squareThumb(src, cx, cy, size, out = 160) {
  const c = document.createElement('canvas');
  c.width = c.height = out;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, cx - size / 2, cy - size / 2, size, size, 0, 0, out, out);
  return c.toDataURL('image/jpeg', 0.82);
}
function coverThumb(canvas, out = 200) {
  const s = Math.min(canvas.width, canvas.height);
  return squareThumb(canvas, canvas.width / 2, canvas.height / 2, s, out);
}
const isImage = (f) => f && (f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp|gif|avif)$/i.test(f.name));

/* ---------- Photos ---------- */
let prepChain = Promise.resolve();
function addPhotos(files) {
  for (const file of files) {
    if (!isImage(file)) continue;
    const p = { id: nid('p'), file, name: file.name, w: 0, h: 0, thumb: null, previewBlob: null, previewUrl: null, ready: null, processed: false, error: null };
    p.ready = prepChain = prepChain.then(() => preparePhoto(p));
    state.photos.push(p);
  }
  renderPhotos();
  updateButtons();
}
async function preparePhoto(p) {
  if (!state.photos.includes(p)) return;
  try {
    const img = await loadImage(p.file);
    p.w = img.naturalWidth; p.h = img.naturalHeight;
    const c = fitCanvas(img, p.w, p.h, PREVIEW_SIDE);
    freeImage(img);
    p.previewBlob = await toBlob(c, 'image/jpeg', 0.9);
    p.previewUrl = URL.createObjectURL(p.previewBlob);
    p.thumb = coverThumb(c, 220);
  } catch (err) {
    p.error = 'Illisible';
    p.processed = true;
  }
  renderPhotos();
}
function removePhoto(id) {
  const p = state.photos.find((x) => x.id === id);
  if (!p) return;
  state.photos = state.photos.filter((x) => x !== p);
  const gone = new Set(state.faces.filter((f) => f.photoId === id).map((f) => f.id));
  state.faces = state.faces.filter((f) => !gone.has(f.id));
  gone.forEach((fid) => state.selected.delete(fid));
  if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
  const r = state.results.get(id);
  if (r) { URL.revokeObjectURL(r.url); state.results.delete(id); }
  cleanupGroups();
  renderAll();
}

/* ---------- Remplacements ---------- */
let replChain = Promise.resolve();
function addRepls(files, extra = null) {
  for (const file of files) {
    if (!isImage(file)) continue;
    const r = {
      id: nid('r'), file, name: file.name, thumb: null, preview: null, src: null, face: null,
      crop: null, cropEdited: false, bg: { mode: 'none', tol: 30 }, cut: null, rev: 0, ready: false, error: null,
      style: defaultStyle(), adj: defaultAdj(), collar: defaultCollar(),
    };
    if (extra) Object.assign(r, extra);
    state.repls.push(r);
    replChain = replChain.then(() => prepareRepl(r));
  }
  renderRepls();
}
async function prepareRepl(r) {
  if (!state.repls.includes(r)) return;
  try {
    if (!r.hash) r.hash = await hashBlob(r.file);
    const dup = state.repls.find((x) => x !== r && x.hash === r.hash);
    if (dup) {
      state.repls = state.repls.filter((x) => x !== r);
      toast(`« ${baseName(dup.name)} » est déjà dans la liste.`);
      renderRepls();
      return;
    }
    await libReady;
    const it = libItem(r.hash);
    if (it) {
      const fromFile = r.file !== it.src;
      await restoreFromLib(r, it);
      if (fromFile) toast(`Déjà dans la bibliothèque : « ${it.name} ». Recadrage et retouches récupérés.`);
      renderRepls(); renderGroups(); scheduleRender();
      return;
    }
    const img = await loadImage(r.file);
    r.src = fitCanvas(img, img.naturalWidth, img.naturalHeight, 1024);
    freeImage(img);
    r.thumb = coverThumb(r.src, 200);
    r.crop = defaultCrop(r, 'auto');
    const am = r.pudgy ? pudgyPreset(r.pudgy.kind) : autoModel();
    if (am) await applyModelToRepl(r, am);
    r.ready = true;
    updatePreview(r);
    renderRepls(); renderGroups();
    // Si l'image contient un visage, le cadrage par défaut se fait dessus.
    try {
      await loadModels();
      const dets = await faceapi.detectAllFaces(r.src, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 })).withFaceLandmarks();
      if (dets.length) {
        const d = dets.reduce((a, b) => (a.detection.box.area > b.detection.box.area ? a : b));
        const b = d.detection.box;
        r.face = { cx: b.x + b.width / 2, cy: b.y + b.height / 2, size: Math.max(b.width, b.height), angle: eyeAngle(d.landmarks) };
        if (!r.cropEdited) { r.crop = defaultCrop(r, 'auto'); r.rev++; }
      }
      if (!state.busy) setStatus('');
    } catch (e) { /* pas grave : centrage simple */ }
  } catch (err) {
    r.error = 'Illisible';
  }
  r.patch = null;
  if (r.ready) updatePreview(r);
  renderRepls(); renderGroups(); scheduleRender();
}

// Réglages propres à chaque image de remplacement ('global' = suivre l'étape 3)
const defaultStyle = () => ({ shape: 'global', size: 1, outline: 'global', flip: false });
const defaultAdj = () => ({ bright: 0, contrast: 0, sat: 0 });
const adjIsNeutral = (a) => !a.bright && !a.contrast && !a.sat;
// Retouches (luminosité, contraste, saturation) appliquées pixel par pixel : fonctionne partout, y compris vieux Safari.
function adjustCanvas(src, a) {
  if (adjIsNeutral(a)) return src;
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
  const C = a.contrast * 1.28, cf = (259 * (C + 255)) / (255 * (259 - C));
  const b = a.bright * 0.96, sf = 1 + a.sat / 100;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], bl = d[i + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * bl;
    r = gray + (r - gray) * sf; g = gray + (g - gray) * sf; bl = gray + (bl - gray) * sf;
    d[i] = (r - 128) * cf + 128 + b; d[i + 1] = (g - 128) * cf + 128 + b; d[i + 2] = (bl - 128) * cf + 128 + b;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
// 'auto' = visage s'il y en a un, sinon carré central ; 'face' ; 'full' = image entière visible
function defaultCrop(r, kind) {
  const w = r.src.width, h = r.src.height;
  if ((kind === 'auto' || kind === 'face') && r.face) {
    return { cx: r.face.cx, cy: r.face.cy, size: r.face.size * 1.6, angle: r.face.angle };
  }
  return { cx: w / 2, cy: h / 2, size: kind === 'full' ? Math.max(w, h) : Math.min(w, h), angle: 0 };
}
function updatePreview(r) {
  const p = getPatch(r, false);
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  c.getContext('2d').drawImage(p, 0, 0, 160, 160);
  r.preview = c.toDataURL('image/png');
}
function removeRepl(id) {
  state.repls = state.repls.filter((r) => r.id !== id);
  state.groups.forEach((g) => { if (g.replId === id) g.replId = null; });
  renderAll(); scheduleRender();
}

/* ---------- Détection ---------- */
function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}
function eyeAngle(lm) {
  const l = centroid(lm.getLeftEye()), r = centroid(lm.getRightEye());
  return Math.atan2(r.y - l.y, r.x - l.x);
}
async function detectPhoto(p) {
  await p.ready;
  if (p.error || !p.previewBlob) return [];
  const img = await loadImage(p.previewBlob);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  freeImage(img);
  const k = p.w / c.width;
  const dets = await faceapi
    .detectAllFaces(c, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.45, maxResults: 100 }))
    .withFaceLandmarks()
    .withFaceDescriptors();
  return dets.map((d) => {
    const b = d.detection.box;
    return {
      id: nid('f'),
      photoId: p.id,
      box: { x: b.x * k, y: b.y * k, w: b.width * k, h: b.height * k },
      angle: eyeAngle(d.landmarks),
      desc: d.descriptor,
      thumb: squareThumb(c, b.x + b.width / 2, b.y + b.height / 2, Math.max(b.width, b.height) * 1.35, 128),
      groupId: null,
    };
  });
}
async function detect() {
  const todo = state.photos.filter((p) => !p.processed);
  if (!todo.length || state.busy) return;
  state.busy = true; updateButtons();
  try {
    await loadModels();
    const found = [];
    for (let i = 0; i < todo.length; i++) {
      const p = todo[i];
      setStatus(`Analyse de « ${p.name} » (${i + 1}/${todo.length})`, i / todo.length);
      await nextFrame();
      try {
        const faces = await detectPhoto(p);
        if (!state.photos.includes(p)) continue;
        found.push(...faces);
        p.faceCount = faces.length;
      } catch (err) {
        console.error(err);
        p.error = 'Erreur';
      }
      p.processed = true;
      renderPhotos();
    }
    state.faces.push(...found);
    integrateFaces(found);
    setStatus(`${found.length} visage${found.length > 1 ? 's' : ''} trouvé${found.length > 1 ? 's' : ''} sur ${todo.length} photo${todo.length > 1 ? 's' : ''}.`);
  } catch (err) {
    console.error(err);
    setStatus('Impossible de charger les modèles : ' + err.message + '. Vérifie que l\'app est servie par un serveur (voir LISEZMOI).');
  } finally {
    state.busy = false;
    renderAll();
    scheduleRender();
  }
}

/* ---------- Regroupement ---------- */
function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}
// Classification hiérarchique « average linkage », avec interdiction de réunir deux visages d'une même photo.
function clusterFaces(faces, t) {
  const n = faces.length;
  if (!n) return [];
  const members = faces.map((f) => [f]);
  const active = new Array(n).fill(true);
  const D = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = faces[i].photoId === faces[j].photoId ? Infinity : dist(faces[i].desc, faces[j].desc);
    D[i][j] = D[j][i] = d;
  }
  for (;;) {
    let bi = -1, bj = -1, bd = t;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      for (let j = i + 1; j < n; j++) if (active[j] && D[i][j] < bd) { bd = D[i][j]; bi = i; bj = j; }
    }
    if (bi < 0) break;
    const ni = members[bi].length, nj = members[bj].length;
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === bi || k === bj) continue;
      const a = D[bi][k], b = D[bj][k];
      const d = a === Infinity || b === Infinity ? Infinity : (ni * a + nj * b) / (ni + nj);
      D[bi][k] = D[k][bi] = d;
    }
    members[bi].push(...members[bj]);
    active[bj] = false;
  }
  return members.filter((_, i) => active[i]);
}
function newGroup() {
  const g = { id: nid('g'), name: `Personne ${++groupCounter}`, replId: null };
  state.groups.push(g);
  return g;
}
const facesOf = (gid) => state.faces.filter((f) => f.groupId === gid);
// Rattache de nouveaux visages aux personnes existantes sans casser les corrections manuelles.
function integrateFaces(newFaces) {
  const clusters = clusterFaces(newFaces, state.threshold);
  for (const c of clusters) {
    let best = null, bd = state.threshold;
    for (const g of state.groups) {
      const gf = facesOf(g.id);
      if (!gf.length || gf.some((f) => c.some((x) => x.photoId === f.photoId))) continue;
      let s = 0;
      for (const a of c) for (const b of gf) s += dist(a.desc, b.desc);
      const d = s / (c.length * gf.length);
      if (d < bd) { bd = d; best = g; }
    }
    const g = best || newGroup();
    c.forEach((f) => { f.groupId = g.id; });
  }
}
function regroupAll() {
  const old = new Map(state.faces.map((f) => [f.id, f.groupId]));
  const oldGroups = new Map(state.groups.map((g) => [g.id, g]));
  const active = state.faces.filter((f) => f.groupId !== 'ignored');
  state.groups = []; groupCounter = 0;
  for (const c of clusterFaces(active, state.threshold)) {
    const g = newGroup();
    // Garde le nom et l'image de l'ancien groupe majoritaire
    const votes = new Map();
    c.forEach((f) => { f.groupId = g.id; const o = old.get(f.id); votes.set(o, (votes.get(o) || 0) + 1); });
    const top = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    const og = top && oldGroups.get(top[0]);
    if (og) { g.replId = og.replId; if (!/^Personne \d+$/.test(og.name)) g.name = og.name; }
  }
  state.selected.clear();
  renderAll(); scheduleRender();
}
function cleanupGroups() {
  const used = new Set(state.faces.map((f) => f.groupId));
  state.groups = state.groups.filter((g) => used.has(g.id));
}
function sortedGroups() {
  const counts = new Map();
  state.faces.forEach((f) => counts.set(f.groupId, (counts.get(f.groupId) || 0) + 1));
  return state.groups.slice().sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0));
}
function moveSelected(target) {
  if (!state.selected.size) return;
  let gid = target;
  if (target === 'new') gid = newGroup().id;
  state.faces.forEach((f) => { if (state.selected.has(f.id)) f.groupId = gid; });
  state.selected.clear();
  cleanupGroups();
  renderGroups(); scheduleRender();
}
function mergeGroups(intoId, fromId) {
  const into = state.groups.find((g) => g.id === intoId), from = state.groups.find((g) => g.id === fromId);
  if (!into || !from) return;
  state.faces.forEach((f) => { if (f.groupId === fromId) f.groupId = intoId; });
  if (!into.replId) into.replId = from.replId;
  cleanupGroups();
  renderGroups(); scheduleRender();
}

/* ---------- Rendu ---------- */
const rawSource = (r) => (r.bg.mode !== 'none' && r.cut ? r.cut : r.src);
function replSource(r) {
  if (r.view && r.viewKey === r.rev) return r.view;
  r.view = adjustCanvas(rawSource(r), r.adj); r.viewKey = r.rev;
  return r.view;
}
// Dessine le cadrage d'une image de remplacement dans un carré de N px.
function withCrop(ctx, crop, N, flip, fn) {
  ctx.save();
  ctx.translate(N / 2, N / 2);
  ctx.scale(N / crop.size, N / crop.size);
  if (flip) ctx.scale(-1, 1);
  ctx.rotate(-crop.angle);
  ctx.translate(-crop.cx, -crop.cy);
  fn();
  ctx.restore();
}
function drawCrop(ctx, src, crop, N, flip) {
  withCrop(ctx, crop, N, flip, () => ctx.drawImage(src, 0, 0));
}
// sticker = contour blanc qui suit la silhouette détourée
function getPatch(r, sticker) {
  const key = `${r.rev}|${sticker ? 1 : 0}`;
  if (r.patch && r.patchKey === key) return r.patch;
  const N = 768;
  const base = document.createElement('canvas');
  base.width = base.height = N;
  const bctx = base.getContext('2d');
  drawCrop(bctx, replSource(r), r.crop, N, r.style.flip);
  if (r.erase) { bctx.globalCompositeOperation = 'destination-out'; drawCrop(bctx, r.erase, r.crop, N, r.style.flip); }
  cutCollar(bctx, r.collar, r.src.width, r.src.height, r.crop, N, r.style.flip);
  let c = base;
  if (sticker) {
    const sil = document.createElement('canvas');
    sil.width = sil.height = N;
    const sctx = sil.getContext('2d');
    sctx.drawImage(base, 0, 0);
    sctx.globalCompositeOperation = 'source-in';
    sctx.fillStyle = '#fff';
    sctx.fillRect(0, 0, N, N);
    c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d');
    const lw = N * 0.025;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      ctx.drawImage(sil, Math.cos(a) * lw, Math.sin(a) * lw);
    }
    // garde seulement l'anneau extérieur, pour que le blanc ne transparaisse pas à travers l'image
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 4; i++) ctx.drawImage(sil, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(base, 0, 0);
  }
  r.patch = c; r.patchKey = key;
  return c;
}
function shapePath(ctx, shape, s) {
  ctx.beginPath();
  addShape(ctx, shape, s);
}
function addShape(ctx, shape, s) {
  const h = s / 2;
  if (shape === 'circle') { ctx.moveTo(h, 0); ctx.arc(0, 0, h, 0, Math.PI * 2); }
  else if (shape === 'ellipse') { ctx.moveTo(h * 0.84, 0); ctx.ellipse(0, 0, h * 0.84, h, 0, 0, Math.PI * 2); }
  else if (shape === 'rounded') {
    const rr = s * 0.22;
    ctx.moveTo(-h + rr, -h);
    ctx.arcTo(h, -h, h, h, rr); ctx.arcTo(h, h, -h, h, rr);
    ctx.arcTo(-h, h, -h, -h, rr); ctx.arcTo(-h, -h, h, -h, rr);
    ctx.closePath();
  } else if (shape === 'hexagon') {
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 3;
      ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * h, Math.sin(a) * h);
    }
    ctx.closePath();
  } else if (shape === 'star') {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, rad = i % 2 ? h * 0.5 : h;
      ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rad, Math.sin(a) * rad + h * 0.06);
    }
    ctx.closePath();
  } else if (shape === 'heart') {
    ctx.moveTo(0, -h * 0.5);
    ctx.bezierCurveTo(h * 0.12, -h * 0.98, h * 1.02, -h * 0.98, h * 0.98, -h * 0.32);
    ctx.bezierCurveTo(h * 0.95, h * 0.2, h * 0.38, h * 0.55, 0, h * 0.95);
    ctx.bezierCurveTo(-h * 0.38, h * 0.55, -h * 0.95, h * 0.2, -h * 0.98, -h * 0.32);
    ctx.bezierCurveTo(-h * 1.02, -h * 0.98, -h * 0.12, -h * 0.98, 0, -h * 0.5);
    ctx.closePath();
  } else ctx.rect(-h, -h, s, s);
}
const replFor = (f) => {
  const g = state.groups.find((x) => x.id === f.groupId);
  const r = g && g.replId && state.repls.find((x) => x.id === g.replId);
  return r && r.ready ? r : null;
};
const NO_FADJ = { dx: 0, dy: 0, k: 1, rot: 0, hidden: false };
const fadjOf = (f) => f.adj || NO_FADJ;
const effShape = (r) => (r.style.shape === 'global' ? state.settings.shape : r.style.shape);
const effOutline = (r) => (r.style.outline === 'global' ? state.settings.outline : r.style.outline === 'on');
const hasRepl = (p) => state.faces.some((f) => f.photoId === p.id && replFor(f));
function photoSig(p) {
  const st = state.settings;
  const parts = state.faces.filter((f) => f.photoId === p.id).map((f) => {
    const r = replFor(f), a = fadjOf(f);
    if (!r || a.hidden) return '';
    return `${f.id}:${r.id}:${r.rev}:${a.dx.toFixed(4)}:${a.dy.toFixed(4)}:${a.k.toFixed(4)}:${a.rot.toFixed(4)}`;
  }).filter(Boolean);
  if (!parts.length) return '';
  return `${st.shape}|${st.scale}|${st.rotate}|${st.outline}|${parts.join(',')}`;
}
// Position, taille et angle d'un visage remplacé, en pixels du canvas (k = échelle canvas / photo).
function faceGeom(f, r, k) {
  const st = state.settings, a = fadjOf(f);
  const fs = Math.max(f.box.w, f.box.h);
  return {
    x: (f.box.x + f.box.w / 2 + a.dx * fs) * k,
    y: (f.box.y + f.box.h / 2 + a.dy * fs) * k,
    s: fs * st.scale * r.style.size * a.k * k,
    angle: (st.rotate ? f.angle : 0) + a.rot,
  };
}
function drawFace(ctx, f, r, k) {
  const { x, y, s, angle } = faceGeom(f, r, k);
  const shape = effShape(r), outline = effOutline(r);
  const free = shape === 'none';
  const cutout = r.bg.mode !== 'none' && r.cut;
  const patch = getPatch(r, free && outline && cutout);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  if (free) {
    ctx.drawImage(patch, -s / 2, -s / 2, s, s);
    if (outline && !cutout) {
      ctx.lineWidth = Math.max(2, s * 0.03);
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(-s / 2, -s / 2, s, s);
    }
  } else {
    shapePath(ctx, shape, s);
    ctx.save();
    ctx.clip();
    ctx.drawImage(patch, -s / 2, -s / 2, s, s);
    ctx.restore();
    if (outline) {
      ctx.lineWidth = Math.max(2, s * 0.03);
      ctx.strokeStyle = '#fff';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }
  ctx.restore();
}
function drawFaces(ctx, p, k) {
  for (const f of state.faces) {
    if (f.photoId !== p.id || fadjOf(f).hidden) continue;
    const r = replFor(f);
    if (r) drawFace(ctx, f, r, k);
  }
}
async function renderPhoto(p, full) {
  const img = await loadImage(full ? p.file : p.previewBlob);
  const c = fitCanvas(img, img.naturalWidth, img.naturalHeight, full ? Infinity : PREVIEW_SIDE);
  freeImage(img);
  drawFaces(c.getContext('2d'), p, c.width / p.w);
  return toBlob(c, 'image/jpeg', full ? 0.93 : 0.85);
}

let renderTimer = null, renderToken = 0;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderResults, 250);
}
async function renderResults() {
  const token = ++renderToken;
  drawResultsGrid();
  for (const p of state.photos) {
    if (token !== renderToken) return;
    if (!p.processed || p.error) continue;
    const sig = photoSig(p);
    const cur = state.results.get(p.id);
    if (!sig) {
      if (cur) { URL.revokeObjectURL(cur.url); state.results.delete(p.id); drawResultsGrid(); }
      continue;
    }
    if (cur && cur.sig === sig) continue;
    markBusy(p.id, true);
    try {
      const blob = await renderPhoto(p, false);
      if (token !== renderToken) return;
      if (cur) URL.revokeObjectURL(cur.url);
      state.results.set(p.id, { sig, url: URL.createObjectURL(blob) });
    } catch (err) { console.error(err); }
    drawResultsGrid();
    await nextFrame();
  }
}

/* ---------- Export ---------- */
const outName = (p) => p.name.replace(/\.[^.]+$/, '') + '-pfp.jpg';
async function buildFiles(photos) {
  const files = [];
  for (const p of photos) {
    const blob = await renderPhoto(p, true);
    files.push(new File([blob], outName(p), { type: 'image/jpeg' }));
  }
  return files;
}
async function deliver(files) {
  if (navigator.canShare && navigator.share) {
    let ok = false;
    try { ok = navigator.canShare({ files }); } catch (e) { ok = false; }
    if (ok) {
      try { await navigator.share({ files }); return 'done'; }
      catch (e) {
        if (e.name === 'AbortError') return 'done';
        if (e.name === 'NotAllowedError') return 'retap';
      }
    }
  }
  for (const f of files) {
    const a = el('a', { href: URL.createObjectURL(f), download: f.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    await sleep(350);
  }
  return 'done';
}
// Le partage iOS exige un geste récent : si la préparation a été longue, on demande un second appui.
async function saveWithButton(btn, getFiles, label) {
  if (btn._files) {
    const files = btn._files; btn._files = null; btn.textContent = label;
    await deliver(files);
    return;
  }
  btn.disabled = true; btn.textContent = 'Préparation…';
  try {
    const files = await getFiles();
    btn.disabled = false;
    if ((await deliver(files)) === 'retap') { btn._files = files; btn.textContent = 'Toucher pour enregistrer'; return; }
  } catch (err) {
    console.error(err); alertStatus('Export impossible : ' + err.message);
  }
  btn.disabled = false; btn.textContent = label;
  updateButtons();
}

/* ---------- Visionneuse ---------- */
const viewer = { photo: null, fullFile: null, fullUrl: null, token: 0 };
async function openViewer(id, edit) {
  const p = state.photos.find((x) => x.id === id);
  const r = state.results.get(id);
  if (!p) return;
  viewer.photo = p; viewer.fullFile = null;
  const token = ++viewer.token;
  if (viewer.fullUrl) { URL.revokeObjectURL(viewer.fullUrl); viewer.fullUrl = null; }
  setFxMode(false);
  $('#viewer-img').src = r ? r.url : p.previewUrl;
  $('#viewer-edit').hidden = !hasRepl(p);
  $('#viewer-save').hidden = !r;
  $('#viewer-save').textContent = 'Préparation…';
  $('#viewer-save').disabled = true;
  $('#viewer').hidden = false;
  document.body.style.overflow = 'hidden';
  if (edit) { startFx(); return; }
  if (!r) return;
  try {
    const [file] = await buildFiles([p]);
    if (token !== viewer.token) return;
    viewer.fullFile = file;
    viewer.fullUrl = URL.createObjectURL(file);
    $('#viewer-img').src = viewer.fullUrl; // l'appui long enregistre la pleine résolution
    $('#viewer-save').textContent = 'Enregistrer';
    $('#viewer-save').disabled = false;
  } catch (err) {
    $('#viewer-save').textContent = 'Erreur';
  }
}
function closeViewer() {
  viewer.token++;
  setFxMode(false);
  $('#viewer').hidden = true;
  document.body.style.overflow = '';
  if (viewer.fullUrl) { URL.revokeObjectURL(viewer.fullUrl); viewer.fullUrl = null; }
  $('#viewer-img').removeAttribute('src');
}

/* ---------- Ajustement visage par visage sur la photo finale ---------- */
const fx = { on: false, base: null, k: 1, sel: null, pointers: new Map() };
function setFxMode(on) {
  fx.on = on;
  $('#viewer-img').hidden = on;
  $('#viewer-canvas').hidden = !on;
  $('#viewer-bar').hidden = on;
  $('#fx-bar').hidden = !on;
  if (!on) { fx.base = null; fx.sel = null; fx.pointers.clear(); }
}
const fxFaces = () => state.faces.filter((f) => f.photoId === viewer.photo.id && replFor(f));
async function startFx() {
  const p = viewer.photo;
  const token = ++viewer.token;
  if (viewer.fullUrl) { URL.revokeObjectURL(viewer.fullUrl); viewer.fullUrl = null; }
  viewer.fullFile = null;
  setFxMode(true);
  const img = await loadImage(p.previewBlob);
  if (token !== viewer.token) { freeImage(img); return; }
  fx.base = fitCanvas(img, img.naturalWidth, img.naturalHeight, PREVIEW_SIDE);
  freeImage(img);
  fx.k = fx.base.width / p.w;
  const cv = $('#viewer-canvas');
  cv.width = fx.base.width; cv.height = fx.base.height;
  const faces = fxFaces();
  fx.sel = faces.length === 1 ? faces[0] : null;
  syncFx(); drawFx();
}
function drawFx() {
  if (!fx.on || !fx.base) return;
  const cv = $('#viewer-canvas'), ctx = cv.getContext('2d');
  ctx.drawImage(fx.base, 0, 0);
  drawFaces(ctx, viewer.photo, fx.k);
  const u = cv.width / Math.max(1, cv.getBoundingClientRect().width); // 1 px écran, en px canvas
  for (const f of fxFaces()) {
    const g = faceGeom(f, replFor(f), fx.k), hidden = fadjOf(f).hidden, sel = f === fx.sel;
    ctx.save();
    ctx.translate(g.x, g.y); ctx.rotate(g.angle);
    if (hidden) { ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(-g.s / 2, -g.s / 2, g.s, g.s); }
    ctx.lineWidth = (sel ? 3 : 1.5) * u;
    ctx.setLineDash(sel ? [] : [6 * u, 5 * u]);
    ctx.strokeStyle = sel ? '#ffd166' : 'rgba(255,255,255,.85)';
    ctx.strokeRect(-g.s / 2, -g.s / 2, g.s, g.s);
    ctx.restore();
  }
}
function syncFx() {
  const f = fx.sel, a = f ? fadjOf(f) : null;
  $('#fx-controls').style.visibility = f ? '' : 'hidden';
  $('#fx-hint').textContent = f
    ? 'Glisse pour déplacer · pince ou molette pour la taille et l\'angle.'
    : 'Touche un visage remplacé pour le régler.';
  if (!f) return;
  $('#fx-size').value = Math.log2(a.k);
  $('#fx-size-out').textContent = Math.round(a.k * 100) + ' %';
  const deg = Math.round((a.rot * 180) / Math.PI);
  $('#fx-rot').value = deg;
  $('#fx-rot-out').textContent = deg + '°';
  $('#fx-hide').textContent = a.hidden ? 'Remettre ce visage' : 'Ne pas remplacer ce visage';
}
function editAdj(f, fn) {
  if (!f.adj) f.adj = { ...NO_FADJ };
  fn(f.adj);
  f.adj.k = Math.min(4, Math.max(0.25, f.adj.k));
  f.adj.rot = Math.atan2(Math.sin(f.adj.rot), Math.cos(f.adj.rot));
  syncFx(); drawFx();
}
function fxPoint(e) {
  const cv = $('#viewer-canvas'), rc = cv.getBoundingClientRect();
  return { x: ((e.clientX - rc.left) / rc.width) * cv.width, y: ((e.clientY - rc.top) / rc.height) * cv.height };
}
function fxHit(pt) {
  let best = null, bd = Infinity;
  for (const f of fxFaces()) {
    const g = faceGeom(f, replFor(f), fx.k);
    const d = Math.hypot(pt.x - g.x, pt.y - g.y);
    if (d < g.s * 0.6 && d < bd) { bd = d; best = f; }
  }
  return best;
}
async function finishFx() {
  const p = viewer.photo;
  setFxMode(false);
  const sig = photoSig(p), cur = state.results.get(p.id);
  if (sig && (!cur || cur.sig !== sig)) {
    const blob = await renderPhoto(p, false);
    const old = state.results.get(p.id);
    if (old) URL.revokeObjectURL(old.url);
    state.results.set(p.id, { sig, url: URL.createObjectURL(blob) });
  } else if (!sig && cur) {
    URL.revokeObjectURL(cur.url); state.results.delete(p.id);
  }
  drawResultsGrid();
  if (!$('#viewer').hidden) openViewer(p.id);
}
(function wireFx() {
  const cv = $('#viewer-canvas');
  cv.addEventListener('pointerdown', (e) => {
    if (!fx.base) return;
    cv.setPointerCapture(e.pointerId);
    const pt = fxPoint(e);
    fx.pointers.set(e.pointerId, pt);
    if (fx.pointers.size === 1) {
      const hit = fxHit(pt);
      if (hit !== fx.sel) { fx.sel = hit; syncFx(); drawFx(); }
    }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!fx.pointers.has(e.pointerId) || !fx.sel) return;
    const before = [...fx.pointers.values()].map((p) => ({ ...p }));
    fx.pointers.set(e.pointerId, fxPoint(e));
    const after = [...fx.pointers.values()];
    const fs = Math.max(fx.sel.box.w, fx.sel.box.h) * fx.k;
    editAdj(fx.sel, (a) => {
      if (after.length === 1) {
        a.dx += (after[0].x - before[0].x) / fs; a.dy += (after[0].y - before[0].y) / fs;
      } else {
        const [a0, b0] = before, [a1, b1] = after;
        a.dx += (a1.x + b1.x - a0.x - b0.x) / 2 / fs; a.dy += (a1.y + b1.y - a0.y - b0.y) / 2 / fs;
        const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y), d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
        if (d0 > 0 && d1 > 0) a.k *= d1 / d0;
        a.rot += Math.atan2(b1.y - a1.y, b1.x - a1.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x);
      }
    });
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => cv.addEventListener(t, (e) => fx.pointers.delete(e.pointerId)));
  cv.addEventListener('wheel', (e) => {
    if (!fx.sel) return;
    e.preventDefault();
    editAdj(fx.sel, (a) => { a.k *= Math.exp(-e.deltaY * 0.0015); });
  }, { passive: false });
  $('#fx-size').addEventListener('input', (e) => { if (fx.sel) editAdj(fx.sel, (a) => { a.k = Math.pow(2, +e.target.value); }); });
  $('#fx-rot').addEventListener('input', (e) => { if (fx.sel) editAdj(fx.sel, (a) => { a.rot = (+e.target.value * Math.PI) / 180; }); });
  $('#fx-hide').addEventListener('click', () => { if (fx.sel) editAdj(fx.sel, (a) => { a.hidden = !a.hidden; }); });
  $('#fx-reset').addEventListener('click', () => { if (fx.sel) { fx.sel.adj = null; syncFx(); drawFx(); } });
  $('#fx-done').addEventListener('click', finishFx);
  $('#viewer-edit').addEventListener('click', () => { if (viewer.photo) startFx(); });
  window.addEventListener('resize', drawFx);
})();

/* ---------- Éditeur de cadrage / détourage ---------- */
const ed = { tool: 'move', erase: null, undo: [], stroke: false, hover: null, brush: 36, r: null, crop: null, bg: null, cut: null, style: null, adj: null, view: null, viewKey: '', cuts: new Map(), pointers: new Map(), token: 0 };
const BG_LABELS = { auto: 'Détourage du sujet…', flat: 'Retrait du fond uni…' };
const sizeBounds = (r) => { const m = Math.max(r.src.width, r.src.height); return [m * 0.04, m * 3]; };

function openEditor(id) {
  const r = state.repls.find((x) => x.id === id);
  if (!r || !r.ready) return;
  ed.r = r;
  ed.crop = { ...r.crop };
  ed.bg = { ...r.bg };
  ed.cut = r.cut;
  ed.style = { ...r.style };
  ed.adj = { ...r.adj };
  ed.view = null;
  ed.erase = r.erase ? cloneCanvas(r.erase) : null;
  ed.collar = { ...defaultCollar(), ...r.collar };
  ed.collarDrag = null;
  renderModels();
  ed.undo = []; ed.stroke = false; ed.hover = null; ed.tool = 'move';
  ed.cuts = new Map();
  if (r.cut) ed.cuts.set(cutKey(r.bg), r.cut);
  ed.pointers.clear();
  $('#ed-name').value = baseName(r.name);
  $('#ed-face').hidden = !r.face;
  $('#ed-tol').value = ed.bg.tol;
  $('#editor').hidden = false;
  document.body.style.overflow = 'hidden';
  syncEditorControls();
  requestAnimationFrame(drawEditor);
}
function closeEditor() {
  ed.token++;
  $('#editor').hidden = true;
  document.body.style.overflow = '';
  ed.r = null; ed.cuts = new Map();
}
const cutKey = (bg) => (bg.mode === 'flat' ? 'flat' + bg.tol : bg.mode);

function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}
/* ---- Gomme : masque (dans les coordonnées de l'image) des zones effacées ---- */
function screenToCanvas(x, y) {
  const cv = $('#ed-canvas'), rc = cv.getBoundingClientRect();
  return { x: ((x - rc.left) / rc.width) * cv.width, y: ((y - rc.top) / rc.height) * cv.height, u: cv.width / rc.width };
}
function canvasToSrc(p) {
  const C = $('#ed-canvas').width, F = C * 0.72, s = F / ed.crop.size, a = ed.crop.angle;
  let qx = (p.x - C / 2) / s;
  const qy = (p.y - C / 2) / s;
  if (ed.style.flip) qx = -qx;
  return { x: qx * Math.cos(a) - qy * Math.sin(a) + ed.crop.cx, y: qx * Math.sin(a) + qy * Math.cos(a) + ed.crop.cy, s };
}
function paintStroke(p0, p1) {
  if (!ed.erase) {
    ed.erase = document.createElement('canvas');
    ed.erase.width = ed.r.src.width; ed.erase.height = ed.r.src.height;
  }
  const a = canvasToSrc(p0), b = canvasToSrc(p1);
  const rad = (ed.brush * p1.u) / 2 / b.s;
  const ctx = ed.erase.getContext('2d');
  ctx.globalCompositeOperation = ed.tool === 'erase' ? 'source-over' : 'destination-out';
  ctx.strokeStyle = ctx.fillStyle = '#000';
  ctx.lineWidth = rad * 2; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.beginPath(); ctx.arc(b.x, b.y, rad, 0, Math.PI * 2); ctx.fill();
}
// Active la ligne du col, placée par défaut un peu sous le centre de la vue.
function enableCollar() {
  if (ed.collar.on) return;
  const w = ed.r.src.width, h = ed.r.src.height;
  if (!ed.collar.placed) {
    ed.collar.vx = ed.crop.cx / w;
    ed.collar.vy = (ed.crop.cy + ed.crop.size * 0.18) / h;
  }
  ed.collar.on = true; ed.collar.placed = true;
}
function pushUndo() {
  ed.undo.push(ed.erase ? cloneCanvas(ed.erase) : null);
  if (ed.undo.length > 25) ed.undo.shift();
}
function popUndo() {
  if (!ed.undo.length) return;
  ed.erase = ed.undo.pop();
  syncEditorControls(); drawEditor();
}
const TIPS = {
  move: 'Glisse pour déplacer · pince ou molette pour zoomer · tourne avec deux doigts. La zone claire est ce qui sera posé sur les visages.',
  erase: 'Frotte pour effacer. Deux doigts (ou molette) pour déplacer et zoomer.',
  restore: 'Frotte pour faire revenir ce qui a été gommé. Deux doigts (ou molette) pour déplacer et zoomer.',
  collar: 'Glisse pour placer la pointe de la ligne jaune sur le col. Tout ce qui est sous la ligne est retiré. Deux doigts pour déplacer et zoomer.',
};
function syncEditorControls() {
  $('#ed-tool').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === ed.tool));
  $('#ed-brush-row').hidden = ed.tool !== 'erase' && ed.tool !== 'restore';
  $('#ed-collar-on').checked = ed.collar.on;
  $('#ed-copen').value = ed.collar.open; $('#ed-copen-out').textContent = Math.round(ed.collar.open) + '°';
  $('#ed-ctilt').value = ed.collar.tilt; $('#ed-ctilt-out').textContent = Math.round(ed.collar.tilt) + '°';
  $('#ed-cround').value = ed.collar.round; $('#ed-cround-out').textContent = Math.round(ed.collar.round);
  $('#ed-brush-out').textContent = ed.brush + ' px';
  $('#ed-undo').disabled = !ed.undo.length;
  $('#ed-erase-clear').disabled = !ed.erase;
  $('#ed-tip').textContent = TIPS[ed.tool];
  $('#ed-canvas').classList.toggle('brush', ed.tool !== 'move');
  const r = ed.r;
  const [mn, mx] = sizeBounds(r);
  const v = Math.log(ed.crop.size / mx) / Math.log(mn / mx);
  $('#ed-zoom').value = v;
  $('#ed-zoom-out').textContent = Math.round((r.src.width / ed.crop.size) * 100) + ' %';
  let deg = Math.round((ed.crop.angle * 180) / Math.PI);
  deg = ((deg + 540) % 360) - 180;
  $('#ed-rot').value = deg;
  $('#ed-rot-out').textContent = deg + '°';
  $('#ed-bgmode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === ed.bg.mode));
  $('#ed-tol-row').hidden = ed.bg.mode !== 'flat';
  $('#ed-tol-out').textContent = ed.bg.tol;
  $('#ed-shape').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === ed.style.shape));
  $('#ed-outline').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === ed.style.outline));
  $('#ed-size').value = ed.style.size;
  $('#ed-size-out').textContent = Math.round(ed.style.size * 100) + ' %';
  $('#ed-flip').setAttribute('aria-pressed', ed.style.flip ? 'true' : 'false');
  for (const k of ['bright', 'contrast', 'sat']) {
    $('#ed-' + k).value = ed.adj[k];
    $('#ed-' + k + '-out').textContent = (ed.adj[k] > 0 ? '+' : '') + ed.adj[k];
  }
}
function editorSource() {
  const raw = ed.bg.mode !== 'none' && ed.cut ? ed.cut : ed.r.src;
  const key = `${ed.adj.bright}|${ed.adj.contrast}|${ed.adj.sat}`;
  if (ed.view && ed.viewRaw === raw && ed.viewKey === key) return ed.view;
  ed.view = adjustCanvas(raw, ed.adj); ed.viewRaw = raw; ed.viewKey = key;
  return ed.view;
}

function drawEditor() {
  if (!ed.r) return;
  const cv = $('#ed-canvas');
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const css = cv.clientWidth;
  if (!css) return;
  const C = Math.round(css * dpr);
  if (cv.width !== C) { cv.width = C; cv.height = C; }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, C, C);
  const F = C * 0.72;
  let layer = ed.layer;
  if (!layer || layer.width !== C) { layer = ed.layer = document.createElement('canvas'); layer.width = layer.height = C; }
  const lctx = layer.getContext('2d');
  lctx.globalCompositeOperation = 'source-over';
  lctx.clearRect(0, 0, C, C);
  lctx.save();
  lctx.translate((C - F) / 2, (C - F) / 2);
  drawCrop(lctx, editorSource(), ed.crop, F, ed.style.flip);
  if (ed.erase) { lctx.globalCompositeOperation = 'destination-out'; drawCrop(lctx, ed.erase, ed.crop, F, ed.style.flip); }
  cutCollar(lctx, ed.collar, ed.r.src.width, ed.r.src.height, ed.crop, F, ed.style.flip);
  lctx.restore();
  ctx.drawImage(layer, 0, 0);
  // voile en dehors de la forme qui sera utilisée sur la photo
  const eff = ed.style.shape === 'global' ? state.settings.shape : ed.style.shape;
  const shape = eff === 'none' ? 'square' : eff;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, C, C);
  ctx.translate(C / 2, C / 2);
  addShape(ctx, shape, F);
  ctx.fillStyle = 'rgba(14, 16, 24, 0.58)';
  ctx.fill('evenodd');
  ctx.beginPath();
  addShape(ctx, shape, F);
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  if (eff === 'none') ctx.setLineDash([8 * dpr, 6 * dpr]);
  ctx.stroke();
  ctx.restore();
  // ligne du col (jaune) et sa pointe
  if (ed.collar.on || ed.tool === 'collar') {
    const w = ed.r.src.width, h = ed.r.src.height, u = (ed.crop.size / F) * dpr;
    ctx.save();
    ctx.translate((C - F) / 2, (C - F) / 2);
    withCrop(ctx, ed.crop, F, ed.style.flip, () => {
      ctx.beginPath(); collarPath(ctx, ed.collar, w, h, false);
      ctx.lineJoin = 'round';
      ctx.lineWidth = 5 * u; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.stroke();
      ctx.lineWidth = 2.5 * u; ctx.strokeStyle = ed.collar.on ? '#ffd166' : 'rgba(255,209,102,.6)';
      if (!ed.collar.on) ctx.setLineDash([8 * u, 6 * u]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(ed.collar.vx * w, ed.collar.vy * h, 8 * u, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd166'; ctx.fill();
      ctx.lineWidth = 2 * u; ctx.strokeStyle = '#000'; ctx.stroke();
    });
    ctx.restore();
  }
  if ((ed.tool === 'erase' || ed.tool === 'restore') && ed.hover) {
    const h = screenToCanvas(ed.hover.x, ed.hover.y);
    ctx.beginPath();
    ctx.arc(h.x, h.y, (ed.brush * h.u) / 2, 0, Math.PI * 2);
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.setLineDash([3 * dpr, 3 * dpr]); ctx.strokeStyle = '#000'; ctx.stroke();
    ctx.setLineDash([]);
  }
}

function clampSize() {
  const [mn, mx] = sizeBounds(ed.r);
  ed.crop.size = Math.min(mx, Math.max(mn, ed.crop.size));
}
// déplacement en pixels écran → déplacement du centre de cadrage dans l'image
function panBy(dx, dy) {
  const cv = $('#ed-canvas');
  const F = cv.clientWidth * 0.72;
  const s = F / ed.crop.size, a = ed.crop.angle;
  if (ed.style.flip) dx = -dx;
  ed.crop.cx -= (dx * Math.cos(a) - dy * Math.sin(a)) / s;
  ed.crop.cy -= (dx * Math.sin(a) + dy * Math.cos(a)) / s;
}

async function setEditorBg(mode, tol) {
  ed.bg = { mode, tol: tol ?? ed.bg.tol };
  syncEditorControls();
  if (mode === 'none') { ed.cut = null; $('#ed-status').textContent = ''; drawEditor(); return; }
  const key = cutKey(ed.bg);
  if (ed.cuts.has(key)) { ed.cut = ed.cuts.get(key); drawEditor(); return; }
  const token = ++ed.token;
  const r = ed.r;
  $('#ed-status').textContent = BG_LABELS[mode] + (mode !== 'flat' ? ' (le premier usage charge le modèle)' : '');
  $('#ed-ok').disabled = true;
  try {
    await nextFrame();
    const cut = await BG.cut(r.src, mode, ed.bg.tol);
    if (token !== ed.token || ed.r !== r) return;
    ed.cuts.set(key, cut);
    ed.cut = cut;
    $('#ed-status').textContent = '';
  } catch (err) {
    console.error(err);
    if (token !== ed.token) return;
    $('#ed-status').textContent = 'Détourage impossible : ' + err.message;
    ed.bg.mode = 'none'; ed.cut = null;
    syncEditorControls();
  } finally {
    if (token === ed.token) $('#ed-ok').disabled = false;
  }
  drawEditor();
}

function applyEditor() {
  const r = ed.r;
  if (!r) return;
  r.crop = { ...ed.crop };
  r.cropEdited = true;
  r.bg = { ...ed.bg };
  r.cut = ed.bg.mode !== 'none' ? ed.cut : null;
  r.style = { ...ed.style };
  const nm = $('#ed-name').value.trim();
  if (nm && nm !== baseName(r.name)) {
    r.name = nm;
    if (libItem(r.hash)) renameLib(r.hash, nm);
  }
  r.adj = { ...ed.adj };
  r.erase = ed.erase;
  r.collar = { ...ed.collar };
  r.rev++;
  r.patch = null; r.view = null;
  updatePreview(r);
  closeEditor();
  renderRepls(); renderGroups(); scheduleRender();
}

(function wireEditor() {
  const cv = $('#ed-canvas');
  cv.addEventListener('pointerdown', (e) => {
    if (!ed.r) return;
    cv.setPointerCapture(e.pointerId);
    ed.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    ed.hover = { x: e.clientX, y: e.clientY };
    if (ed.tool === 'move') return;
    if (ed.tool === 'collar') {
      if (ed.pointers.size === 1) {
        if (!ed.collar.on) enableCollar();
        const p = canvasToSrc(screenToCanvas(e.clientX, e.clientY));
        ed.collarDrag = { dx: ed.collar.vx * ed.r.src.width - p.x, dy: ed.collar.vy * ed.r.src.height - p.y };
      } else ed.collarDrag = null;
      syncEditorControls(); drawEditor();
      return;
    }
    if (ed.pointers.size === 1) {
      pushUndo(); ed.stroke = true;
      const p = screenToCanvas(e.clientX, e.clientY);
      paintStroke(p, p);
    } else if (ed.stroke) {
      // un deuxième doigt : c'était un geste de déplacement, pas un coup de gomme
      ed.stroke = false; popUndo();
    }
    syncEditorControls(); drawEditor();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!ed.r) return;
    ed.hover = { x: e.clientX, y: e.clientY };
    if (!ed.pointers.has(e.pointerId)) { if (ed.tool !== 'move') drawEditor(); return; }
    const before = [...ed.pointers.values()].map((p) => ({ ...p }));
    ed.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const after = [...ed.pointers.values()];
    if (ed.tool !== 'move' && after.length === 1) {
      if (ed.tool === 'collar') {
        if (ed.collarDrag) {
          const p = canvasToSrc(screenToCanvas(after[0].x, after[0].y));
          ed.collar.vx = (p.x + ed.collarDrag.dx) / ed.r.src.width;
          ed.collar.vy = (p.y + ed.collarDrag.dy) / ed.r.src.height;
        }
      } else if (ed.stroke) paintStroke(screenToCanvas(before[0].x, before[0].y), screenToCanvas(after[0].x, after[0].y));
      drawEditor();
      return;
    }
    if (after.length === 1) {
      panBy(after[0].x - before[0].x, after[0].y - before[0].y);
    } else if (after.length >= 2) {
      const [a0, b0] = before, [a1, b1] = after;
      const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y), d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
      const t0 = Math.atan2(b0.y - a0.y, b0.x - a0.x), t1 = Math.atan2(b1.y - a1.y, b1.x - a1.x);
      panBy((a1.x + b1.x - a0.x - b0.x) / 2, (a1.y + b1.y - a0.y - b0.y) / 2);
      if (d0 > 0 && d1 > 0) ed.crop.size *= d0 / d1;
      ed.crop.angle -= (t1 - t0) * (ed.style.flip ? -1 : 1);
      clampSize();
    }
    syncEditorControls();
    drawEditor();
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => cv.addEventListener(t, (e) => {
    ed.pointers.delete(e.pointerId);
    if (!ed.pointers.size) { ed.stroke = false; ed.collarDrag = null; }
  }));
  cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { ed.hover = null; drawEditor(); } });
  $('#ed-tool').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b && ed.r) { ed.tool = b.dataset.v; ed.hover = null; syncEditorControls(); drawEditor(); }
  });
  $('#ed-brush').addEventListener('input', (e) => { ed.brush = +e.target.value; syncEditorControls(); drawEditor(); });
  $('#ed-undo').addEventListener('click', popUndo);
  $('#ed-erase-clear').addEventListener('click', () => { if (ed.erase) { pushUndo(); ed.erase = null; syncEditorControls(); drawEditor(); } });
  cv.addEventListener('wheel', (e) => {
    if (!ed.r) return;
    e.preventDefault();
    ed.crop.size *= Math.exp(e.deltaY * 0.0015);
    clampSize(); syncEditorControls(); drawEditor();
  }, { passive: false });

  $('#ed-zoom').addEventListener('input', (e) => {
    const [mn, mx] = sizeBounds(ed.r);
    ed.crop.size = mx * Math.pow(mn / mx, +e.target.value);
    syncEditorControls(); drawEditor();
  });
  $('#ed-rot').addEventListener('input', (e) => {
    ed.crop.angle = (+e.target.value * Math.PI) / 180;
    syncEditorControls(); drawEditor();
  });
  $('#ed-face').addEventListener('click', () => { ed.crop = defaultCrop(ed.r, 'face'); syncEditorControls(); drawEditor(); });
  $('#ed-full').addEventListener('click', () => { ed.crop = defaultCrop(ed.r, 'full'); syncEditorControls(); drawEditor(); });
  $('#ed-center').addEventListener('click', () => { ed.crop = defaultCrop(ed.r, 'center'); syncEditorControls(); drawEditor(); });
  $('#ed-bgmode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b && ed.r) setEditorBg(b.dataset.v);
  });
  let tolTimer = null;
  $('#ed-tol').addEventListener('input', (e) => {
    $('#ed-tol-out').textContent = e.target.value;
    clearTimeout(tolTimer);
    tolTimer = setTimeout(() => setEditorBg('flat', +e.target.value), 200);
  });
  const segPick = (id, fn) => $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b && ed.r) { fn(b.dataset.v); syncEditorControls(); drawEditor(); }
  });
  segPick('#ed-shape', (v) => { ed.style.shape = v; });
  segPick('#ed-outline', (v) => { ed.style.outline = v; });
  $('#ed-size').addEventListener('input', (e) => { ed.style.size = +e.target.value; syncEditorControls(); });
  $('#ed-flip').addEventListener('click', () => { ed.style.flip = !ed.style.flip; syncEditorControls(); drawEditor(); });
  let adjFrame = 0;
  for (const k of ['bright', 'contrast', 'sat']) {
    $('#ed-' + k).addEventListener('input', (e) => {
      ed.adj[k] = +e.target.value;
      syncEditorControls();
      cancelAnimationFrame(adjFrame);
      adjFrame = requestAnimationFrame(drawEditor);
    });
  }
  $('#ed-adj-reset').addEventListener('click', () => { ed.adj = defaultAdj(); syncEditorControls(); drawEditor(); });
  $('#ed-collar-on').addEventListener('change', (e) => {
    if (!ed.r) return;
    if (e.target.checked) { enableCollar(); ed.tool = 'collar'; } else ed.collar.on = false;
    syncEditorControls(); drawEditor();
  });
  for (const [id, key] of [['#ed-copen', 'open'], ['#ed-ctilt', 'tilt'], ['#ed-cround', 'round']]) {
    $(id).addEventListener('input', (e) => {
      if (!ed.r) return;
      if (!ed.collar.on) enableCollar();
      ed.collar[key] = +e.target.value;
      syncEditorControls(); drawEditor();
    });
  }
  $('#ed-fit').addEventListener('click', () => {
    if (!ed.r) return;
    const f = frameContent(ed.bg.mode !== 'none' && ed.cut ? ed.cut : ed.r.src, ed.erase, ed.collar);
    if (f) { ed.crop = f; syncEditorControls(); drawEditor(); }
  });
  $('#ed-msave').addEventListener('click', saveModel);
  $('#ed-cancel').addEventListener('click', closeEditor);
  $('#ed-ok').addEventListener('click', applyEditor);
  window.addEventListener('resize', () => { if (ed.r) drawEditor(); });
})();

/* ---------- Bibliothèque d'images de remplacement (IndexedDB, sur l'appareil) ---------- */
const LIB = (() => {
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const q = indexedDB.open('pfp-lib', 2);
        q.onupgradeneeded = () => {
          for (const name of ['items', 'models']) {
            if (!q.result.objectStoreNames.contains(name)) q.result.createObjectStore(name, { keyPath: 'id' });
          }
        };
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      }).catch((e) => { dbp = null; throw e; });
    }
    return dbp;
  }
  async function tx(mode, fn, store = 'items') {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => res(r && r.result);
      t.onerror = t.onabort = () => rej(t.error);
    });
  }
  return {
    all: () => tx('readonly', (s) => s.getAll()),
    put: (item) => tx('readwrite', (s) => s.put(item)),
    del: (id) => tx('readwrite', (s) => s.delete(id)),
    allModels: () => tx('readonly', (s) => s.getAll(), 'models'),
    putModel: (m) => tx('readwrite', (s) => s.put(m), 'models'),
    delModel: (id) => tx('readwrite', (s) => s.delete(id), 'models'),
  };
})();
state.lib = [];
const libReady = LIB.all()
  .then((items) => { state.lib = items || []; })
  .catch((err) => { console.warn('Bibliothèque indisponible :', err); state.libError = true; })
  .then(() => renderLib());

// Empreinte du fichier : la même image n'est jamais enregistrée deux fois.
async function hashBlob(b) {
  const buf = await b.arrayBuffer();
  if (window.crypto && crypto.subtle) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return 'h' + [...h.slice(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  const u = new Uint8Array(buf);
  let a = 0x811c9dc5, c = 0x01000193;
  for (let i = 0; i < u.length; i++) { a = Math.imul(a ^ u[i], 16777619) >>> 0; c = Math.imul(c ^ u[i], 2246822519) >>> 0; }
  return 'f' + a.toString(16) + c.toString(16) + u.length.toString(16);
}
async function blobToCanvas(b) {
  const img = await loadImage(b);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  freeImage(img);
  return c;
}
const baseName = (n) => n.replace(/\.[^.]+$/, '');
const libItem = (id) => state.lib.find((x) => x.id === id);

async function restoreFromLib(r, it) {
  r.src = await blobToCanvas(it.src);
  r.cut = it.cut ? await blobToCanvas(it.cut) : null;
  r.erase = it.erase ? await blobToCanvas(it.erase) : null;
  r.face = it.face || null;
  r.crop = { ...it.crop }; r.cropEdited = true;
  r.bg = { ...it.bg }; r.style = { ...defaultStyle(), ...it.style }; r.adj = { ...defaultAdj(), ...it.adj };
  r.collar = { ...defaultCollar(), ...it.collar };
  if (it.pudgy) r.pudgy = { ...it.pudgy };
  r.name = it.name;
  r.thumb = coverThumb(r.src, 200);
  r.rev++; r.patch = null; r.view = null;
  r.ready = true;
  updatePreview(r);
  r.savedRev = r.rev;
}

const libQueue = new Map(); // évite deux écritures simultanées d'une même image
function libSave(r) {
  if (!r.ready || r.error || !r.hash || r.savedRev === r.rev) return Promise.resolve();
  const prevJob = libQueue.get(r.hash) || Promise.resolve();
  const job = prevJob.then(async () => {
    if (r.savedRev === r.rev) return;
    const rev = r.rev, prev = libItem(r.hash);
    const item = {
      id: r.hash,
      name: prev ? prev.name : baseName(r.name),
      created: prev ? prev.created : Date.now(),
      updated: Date.now(),
      src: prev ? prev.src : await toBlob(r.src, 'image/jpeg', 0.92),
      cut: r.bg.mode !== 'none' && r.cut ? await toBlob(r.cut, 'image/png') : null,
      erase: r.erase ? await toBlob(r.erase, 'image/png') : null,
      crop: { ...r.crop }, bg: { ...r.bg }, style: { ...r.style }, adj: { ...r.adj }, collar: { ...r.collar }, face: r.face,
      pudgy: r.pudgy || (prev && prev.pudgy) || null,
      thumb: r.preview,
    };
    await LIB.put(item);
    state.lib = state.lib.filter((x) => x.id !== item.id).concat(item);
    r.savedRev = rev; r.name = item.name;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    renderLib();
    return !prev;
  }).catch((err) => { console.error(err); toast('Bibliothèque : enregistrement impossible (' + err.message + ').'); });
  libQueue.set(r.hash, job);
  return job;
}
// Seules les images réellement posées sur les photos enregistrées vont dans la bibliothèque.
async function libSaveForPhotos(photos) {
  const ids = new Set(photos.map((p) => p.id));
  const repls = new Set();
  for (const f of state.faces) {
    if (!ids.has(f.photoId) || fadjOf(f).hidden) continue;
    const r = replFor(f);
    if (r) repls.add(r);
  }
  const res = await Promise.all([...repls].map(libSave));
  const added = res.filter((x) => x === true).length;
  if (added) toast(`${added} image${added > 1 ? 's' : ''} ajoutée${added > 1 ? 's' : ''} à la bibliothèque.`);
}

function useLib(it) {
  const have = state.repls.find((r) => r.hash === it.id);
  if (have) { toast(`« ${it.name} » est déjà dans la liste.`); return; }
  const r = {
    id: nid('r'), file: it.src, name: it.name, hash: it.id, thumb: it.thumb, preview: it.thumb, src: null, face: null,
    crop: null, cropEdited: true, bg: { mode: 'none', tol: 30 }, cut: null, rev: 0, ready: false, error: null,
    style: defaultStyle(), adj: defaultAdj(), collar: defaultCollar(),
  };
  state.repls.push(r);
  replChain = replChain.then(() => prepareRepl(r));
  renderRepls(); renderLib();
}
async function renameLib(id, name) {
  const it = libItem(id);
  name = name.trim();
  if (!it || !name || name === it.name) { renderLib(); return; }
  const next = { ...it, name, updated: it.updated };
  await LIB.put(next);
  state.lib = state.lib.map((x) => (x.id === id ? next : x));
  state.repls.forEach((r) => { if (r.hash === id) r.name = name; });
  renderLib(); renderRepls(); renderGroups();
}
async function deleteLib(it) {
  if (!confirm(`Retirer « ${it.name} » de la bibliothèque ?\nL'image reste dans la liste en cours si elle y est.`)) return;
  await LIB.del(it.id);
  state.lib = state.lib.filter((x) => x.id !== it.id);
  state.repls.forEach((r) => { if (r.hash === it.id) r.savedRev = undefined; });
  renderLib();
}

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function renderLib() {
  const box = $('#lib-list');
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // ne pas gêner la saisie
  const words = norm($('#lib-q').value.trim()).split(/\s+/).filter(Boolean);
  const items = state.lib
    .filter((it) => words.every((w) => norm(it.name).includes(w)))
    .sort((a, b) => b.updated - a.updated);
  $('#lib-count').textContent = state.lib.length ? String(state.lib.length) : '';
  $('#lib-q').hidden = state.lib.length < 2;
  $('#lib-export').disabled = !state.lib.length;
  let empty = null;
  if (state.libError) empty = 'La bibliothèque n\'est pas disponible dans ce navigateur (navigation privée ?).';
  else if (!state.lib.length) empty = 'Vide pour l\'instant. Les images posées sur des photos que tu enregistres y sont gardées, avec leur recadrage, détourage et gomme.';
  else if (!items.length) empty = 'Aucune image ne porte ce nom.';
  box.replaceChildren(...(empty ? [el('p', { class: 'pane-hint', text: empty })] : items.map((it) => {
    const inSession = state.repls.some((r) => r.hash === it.id);
    return el('div', { class: 'lib-item' + (inSession ? ' on' : '') },
      el('button', { class: 'lib-use checker', title: inSession ? 'Déjà dans la liste' : 'Utiliser', 'aria-label': 'Utiliser ' + it.name, onclick: () => useLib(it) },
        el('img', { src: it.thumb, alt: '' }),
        inSession ? el('span', { class: 'tag', text: 'utilisée' }) : null),
      el('input', {
        class: 'lib-name', value: it.name, 'aria-label': 'Nom de l\'image', enterkeyhint: 'done',
        onchange: (e) => renameLib(it.id, e.target.value),
        onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
        onblur: () => setTimeout(renderLib, 0),
      }),
      el('button', { class: 'x', text: '×', 'aria-label': 'Retirer ' + it.name + ' de la bibliothèque', onclick: () => deleteLib(it) }));
  })));
}

/* Sauvegarde / restauration de la bibliothèque dans un fichier (pour la ranger dans un dossier de Fichiers) */
const blobToDataURL = (b) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(b); });
const dataURLToBlob = async (u) => (u ? (await fetch(u)).blob() : null);
async function exportLib() {
  const items = [];
  for (const it of state.lib) {
    items.push({ ...it, src: await blobToDataURL(it.src), cut: it.cut && await blobToDataURL(it.cut), erase: it.erase && await blobToDataURL(it.erase) });
  }
  const json = JSON.stringify({ format: 'pfp-modifier-bibliotheque', version: 1, items });
  const day = new Date().toISOString().slice(0, 10);
  return [new File([json], `pfp-bibliotheque-${day}.json`, { type: 'application/json' })];
}
async function importLib(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== 'pfp-modifier-bibliotheque' || !Array.isArray(data.items)) throw new Error('ce n\'est pas une sauvegarde de bibliothèque');
    let added = 0, updated = 0;
    for (const raw of data.items) {
      const prev = libItem(raw.id);
      if (prev && prev.updated >= raw.updated) continue;
      const it = { ...raw, src: await dataURLToBlob(raw.src), cut: await dataURLToBlob(raw.cut), erase: await dataURLToBlob(raw.erase) };
      await LIB.put(it);
      state.lib = state.lib.filter((x) => x.id !== it.id).concat(it);
      if (prev) updated++; else added++;
    }
    renderLib();
    toast(`Bibliothèque importée : ${added} ajoutée${added > 1 ? 's' : ''}, ${updated} mise${updated > 1 ? 's' : ''} à jour.`);
  } catch (err) {
    console.error(err);
    toast('Import impossible : ' + err.message);
  }
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

/* ---------- Découpe au col (garder la tête) et modèles de découpe ---------- */
// vx, vy : pointe de la ligne (fraction de la largeur / hauteur de l'image) ;
// open : ouverture en degrés (< 180 = V, > 180 = Λ) ; tilt : inclinaison ; round : arrondi de la pointe (0-100).
const defaultCollar = () => ({ on: false, vx: 0.5, vy: 0.62, open: 150, tilt: 0, round: 0 });
function collarPath(ctx, c, w, h, closed) {
  const V = { x: c.vx * w, y: c.vy * h };
  const R = Math.hypot(w, h) * 2;
  const t = (c.tilt * Math.PI) / 180, half = (c.open * Math.PI) / 360;
  const dir = (a) => ({ x: Math.sin(t + a), y: -Math.cos(t + a) });
  const dl = dir(-half), dr = dir(half), down = { x: -Math.sin(t), y: Math.cos(t) };
  const rd = (c.round / 100) * 0.4 * Math.min(w, h);
  const L = { x: V.x + dl.x * R, y: V.y + dl.y * R }, Rt = { x: V.x + dr.x * R, y: V.y + dr.y * R };
  ctx.moveTo(L.x, L.y);
  if (rd > 0) {
    ctx.lineTo(V.x + dl.x * rd, V.y + dl.y * rd);
    ctx.quadraticCurveTo(V.x, V.y, V.x + dr.x * rd, V.y + dr.y * rd);
  } else ctx.lineTo(V.x, V.y);
  ctx.lineTo(Rt.x, Rt.y);
  if (closed) {
    ctx.lineTo(Rt.x + down.x * R, Rt.y + down.y * R);
    ctx.lineTo(L.x + down.x * R, L.y + down.y * R);
    ctx.closePath();
  }
}
// Retire (destination-out) tout ce qui est sous la ligne du col, dans le repère d'un cadrage.
function cutCollar(ctx, collar, w, h, crop, N, flip) {
  if (!collar || !collar.on) return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  withCrop(ctx, crop, N, flip, () => { ctx.beginPath(); collarPath(ctx, collar, w, h, true); ctx.fill(); });
  ctx.restore();
}
// Boîte englobante de ce qui reste visible (pour cadrer sur la tête).
function frameContent(src, erase, collar) {
  const w = src.width, h = src.height, k = Math.min(1, 320 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.scale(k, k);
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  if (erase) ctx.drawImage(erase, 0, 0, w, h);
  if (collar && collar.on) { ctx.beginPath(); collarPath(ctx, collar, w, h, true); ctx.fill(); }
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  x0 /= k; y0 /= k; x1 = (x1 + 1) / k; y1 = (y1 + 1) / k;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, size: Math.max(x1 - x0, y1 - y0) * 1.04, angle: 0 };
}

state.models = [];
LIB.allModels()
  .then((m) => { state.models = m || []; })
  .catch((err) => console.warn('Modèles indisponibles :', err))
  .then(() => { renderModels(); renderAutoModel(); });
let autoModelId = '';
try { autoModelId = localStorage.getItem('pfp-auto-model') || ''; } catch (e) { /* stockage indisponible */ }
const autoModel = () => state.models.find((m) => m.id === autoModelId && !m.preset) || null;

function modelFromEditor(name) {
  const w = ed.r.src.width, h = ed.r.src.height, M = Math.max(w, h);
  return {
    name, created: Date.now(), autoFrame: $('#ed-mfit').checked,
    crop: { cx: ed.crop.cx / w, cy: ed.crop.cy / h, size: ed.crop.size / M, angle: ed.crop.angle },
    bg: { ...ed.bg }, style: { ...ed.style }, adj: { ...ed.adj }, collar: { ...ed.collar },
  };
}
function modelCrop(m, w, h) {
  return { cx: m.crop.cx * w, cy: m.crop.cy * h, size: m.crop.size * Math.max(w, h), angle: m.crop.angle };
}
async function applyModelToEditor(m) {
  const r = ed.r, w = r.src.width, h = r.src.height;
  ed.collar = { ...defaultCollar(), ...m.collar };
  ed.style = { ...defaultStyle(), ...m.style };
  ed.adj = { ...defaultAdj(), ...m.adj };
  ed.crop = modelCrop(m, w, h);
  syncEditorControls(); drawEditor();
  await setEditorBg(m.bg.mode, m.bg.tol);
  if (ed.r !== r) return;
  if (m.autoFrame) {
    const f = frameContent(ed.bg.mode !== 'none' && ed.cut ? ed.cut : r.src, ed.erase, ed.collar);
    if (f) ed.crop = f;
  }
  syncEditorControls(); drawEditor();
}
async function applyModelToRepl(r, m) {
  r.collar = { ...defaultCollar(), ...m.collar };
  r.style = { ...defaultStyle(), ...m.style };
  r.adj = { ...defaultAdj(), ...m.adj };
  r.bg = { ...m.bg };
  r.cut = null;
  if (m.bg.mode !== 'none') {
    try { r.cut = await BG.cut(r.src, m.bg.mode, m.bg.tol); } catch (err) { console.error(err); r.bg = { mode: 'none', tol: 30 }; }
  }
  r.crop = modelCrop(m, r.src.width, r.src.height);
  if (m.autoFrame) { const f = frameContent(rawSource(r), r.erase, r.collar); if (f) r.crop = f; }
  r.cropEdited = true;
  r.rev++; r.patch = null; r.view = null;
}
async function saveModel() {
  if (!ed.r) return;
  const name = $('#ed-mname').value.trim() || 'Modèle ' + (state.models.length + 1);
  const prev = state.models.find((m) => !m.preset && norm(m.name) === norm(name)); // même nom = mise à jour, pas de doublon
  const m = { ...modelFromEditor(name), id: prev ? prev.id : 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) };
  try {
    await LIB.putModel(m);
    state.models = state.models.filter((x) => x.id !== m.id).concat(m);
    $('#ed-mname').value = '';
    toast(prev ? `Modèle « ${name} » mis à jour.` : `Modèle « ${name} » enregistré.`);
  } catch (err) { toast('Modèle non enregistré : ' + err.message); }
  renderModels(); renderAutoModel();
}
async function deleteModel(m) {
  if (!confirm(`Supprimer le modèle « ${m.name} » ?`)) return;
  await LIB.delModel(m.id);
  state.models = state.models.filter((x) => x.id !== m.id);
  renderModels(); renderAutoModel();
}
function renderModels() {
  const box = $('#ed-models');
  const list = state.models.filter((m) => !m.preset).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  renderPresetBox();
  box.replaceChildren(...(list.length ? list.map((m) => el('span', { class: 'model-chip' },
    el('button', { class: 'apply', text: m.name, title: 'Appliquer ce modèle', onclick: () => { if (ed.r) applyModelToEditor(m); } }),
    el('button', { class: 'del', text: '×', 'aria-label': 'Supprimer le modèle ' + m.name, onclick: () => deleteModel(m) })))
    : [el('span', { class: 'pane-hint', text: 'Aucun modèle pour l\'instant.' })]));
}
function renderAutoModel() {
  const sel = $('#auto-model');
  const models = state.models.filter((m) => !m.preset);
  $('#auto-model-row').hidden = !models.length;
  if (autoModelId && !autoModel()) autoModelId = '';
  sel.replaceChildren(el('option', { value: '', text: 'telles quelles' }),
    ...models.sort((a, b) => a.name.localeCompare(b.name, 'fr')).map((m) => el('option', { value: m.id, text: 'modèle « ' + m.name + ' »' })));
  sel.value = autoModelId;
}
$('#auto-model').addEventListener('change', (e) => {
  autoModelId = e.target.value;
  try { localStorage.setItem('pfp-auto-model', autoModelId); } catch (err) { /* stockage indisponible */ }
});

/* ---------- Pudgy Penguins : ajout par numéro et preset de découpe par collection ---------- */
const PUDGY = {
  big: {
    label: 'Big', name: 'Big Pudgy', max: 8887,
    urls: (n) => ['https://ipfs.filebase.io', 'https://gateway.pinata.cloud', 'https://ipfs.io', 'https://dweb.link', 'https://w3s.link', 'https://4everland.io']
      .map((g) => `${g}/ipfs/QmNf1UsmdGaMbpatQ6toXSkzDpizaGmC9zfunCyoz1enD5/penguin/${n}.png`),
    // preset d'origine : fond uni retiré, coupé au col (buste), tête recadrée
    preset: { autoFrame: true, crop: { cx: 0.5, cy: 0.42, size: 0.8, angle: 0 }, bg: { mode: 'flat', tol: 14 },
      style: { shape: 'none', size: 1, outline: 'global', flip: false }, adj: { bright: 0, contrast: 0, sat: 0 },
      collar: { on: true, vx: 0.5, vy: 0.8, open: 140, tilt: 0, round: 30 } },
  },
  lil: {
    label: 'Lil', name: 'Lil Pudgy', max: 22221,
    urls: (n) => [`https://api.pudgypenguins.io/lil/image/${n}`],
    preset: { autoFrame: true, crop: { cx: 0.5, cy: 0.55, size: 0.4, angle: 0 }, bg: { mode: 'flat', tol: 14 },
      style: { shape: 'none', size: 1, outline: 'global', flip: false }, adj: { bright: 0, contrast: 0, sat: 0 },
      collar: { on: true, vx: 0.5, vy: 0.73, open: 170, tilt: 0, round: 20 } },
  },
};
// Pudgys « classiques » : peau bleue ou rose, sans chapeau ni accessoire, visage « Cute » (trouvés dans les métadonnées on-chain).
const PUDGY_CLASSICS = [
  { kind: 'lil', n: 2928, label: 'Lil bleu', color: '#4467b5' },
  { kind: 'lil', n: 7646, label: 'Lil rose', color: '#f5c2dc' },
  { kind: 'big', n: 6803, label: 'Big classique', color: '#1b2233' }, // les Big n'ont pas de peau bleue
];
const pudgyPreset = (kind) => state.models.find((m) => m.preset === kind) || { ...PUDGY[kind].preset, name: 'Preset ' + PUDGY[kind].label };

async function fetchPudgy(kind, n) {
  let last = null;
  for (const url of PUDGY[kind].urls(n)) {
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
      const res = await fetch(url, { mode: 'cors', signal: ctl.signal }).finally(() => clearTimeout(timer));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      if (!blob.type.startsWith('image/')) throw new Error('pas une image');
      return new File([blob], `${PUDGY[kind].name} #${n}.png`, { type: blob.type });
    } catch (err) { last = err; }
  }
  throw last || new Error('introuvable');
}
function parseNums(txt, max) {
  const out = [], bad = [];
  for (const t of txt.split(/[\s,;]+/).filter(Boolean)) {
    const n = Number(t.replace(/^#/, ''));
    if (Number.isInteger(n) && n >= 0 && n <= max) { if (!out.includes(n)) out.push(n); } else bad.push(t);
  }
  return { out, bad };
}
let pudgyBusy = 0;
async function addPudgys(kind, nums) {
  const btn = $('#pg-add');
  pudgyBusy++; btn.disabled = true; btn.textContent = 'Téléchargement…';
  const failed = [];
  const have = (n) => state.repls.some((r) => r.pudgy && r.pudgy.kind === kind && r.pudgy.n === n);
  const dl = nums.map((n) => {
    if (have(n)) { toast(`${PUDGY[kind].name} #${n} est déjà dans la liste.`); return null; }
    return fetchPudgy(kind, n).catch((err) => { console.error(err); failed.push(n); return null; });
  });
  // ajoutés dans l'ordre demandé, chacun dès qu'il est prêt
  for (let i = 0; i < nums.length; i++) {
    const file = await dl[i];
    if (file && !have(nums[i])) addRepls([file], { pudgy: { kind, n: nums[i] } });
  }
  if (--pudgyBusy === 0) { btn.disabled = false; btn.textContent = 'Ajouter'; }
  if (failed.length) toast(`Téléchargement impossible : ${PUDGY[kind].name} #${failed.join(', #')}. Vérifie la connexion.`);
}
function submitPudgy() {
  const kind = $('#pg-kind').value, { out, bad } = parseNums($('#pg-num').value, PUDGY[kind].max);
  if (bad.length) { toast(`Numéro invalide : ${bad.join(', ')} (${PUDGY[kind].name} : 0 à ${PUDGY[kind].max}).`); return; }
  if (!out.length) { $('#pg-num').focus(); return; }
  $('#pg-num').value = '';
  addPudgys(kind, out);
}
$('#pg-add').addEventListener('click', submitPudgy);
$('#pg-num').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitPudgy(); } });
$('#pg-classics').replaceChildren(...PUDGY_CLASSICS.map((c) => el('button', {
  class: 'btn small', title: `${PUDGY[c.kind].name} #${c.n}`, onclick: () => addPudgys(c.kind, [c.n]),
}, el('span', { class: 'dot', style: `background:${c.color}` }), c.label)));

// Preset dans l'éditeur (visible seulement pour un Pudgy)
function renderPresetBox() {
  const box = $('#ed-preset'), p = ed.r && ed.r.pudgy;
  box.hidden = !p;
  if (!p) return;
  const k = PUDGY[p.kind], custom = state.models.some((m) => m.preset === p.kind);
  $('#ed-preset-title').textContent = `${k.name} #${p.n} — preset ${k.label} ${custom ? '(personnalisé)' : "(d'origine)"}`;
  $('#ed-preset-save').textContent = `Enregistrer comme preset ${k.label}`;
  $('#ed-preset-reset').hidden = !custom;
}
async function reapplyPreset(kind, except) {
  const m = pudgyPreset(kind);
  const list = state.repls.filter((r) => r.ready && !r.error && r.pudgy && r.pudgy.kind === kind && r !== except);
  for (const r of list) { await applyModelToRepl(r, m); updatePreview(r); }
  if (list.length) { renderRepls(); renderGroups(); scheduleRender(); }
  return list.length;
}
async function savePreset() {
  const p = ed.r && ed.r.pudgy;
  if (!p) return;
  const k = PUDGY[p.kind];
  const m = { ...modelFromEditor('Preset ' + k.label), id: 'preset-' + p.kind, preset: p.kind };
  try { await LIB.putModel(m); } catch (err) { toast('Preset non enregistré : ' + err.message); return; }
  state.models = state.models.filter((x) => x.id !== m.id).concat(m);
  renderPresetBox();
  const n = await reapplyPreset(p.kind, ed.r);
  toast(`Preset ${k.label} enregistré` + (n ? ` et appliqué aux ${n} autre${n > 1 ? 's' : ''} ${k.name}.` : '. Il servira pour les prochains ' + k.name + '.'));
}
async function resetPreset() {
  const p = ed.r && ed.r.pudgy;
  if (!p) return;
  const k = PUDGY[p.kind];
  if (!confirm(`Revenir au preset ${k.label} d'origine ?`)) return;
  await LIB.delModel('preset-' + p.kind);
  state.models = state.models.filter((m) => m.preset !== p.kind);
  await applyModelToEditor(pudgyPreset(p.kind));
  renderPresetBox();
  const n = await reapplyPreset(p.kind, ed.r);
  toast(`Preset ${k.label} d'origine rétabli` + (n ? ` (${n} autre${n > 1 ? 's' : ''} ${k.name} mis à jour).` : '.'));
}
$('#ed-preset-save').addEventListener('click', savePreset);
$('#ed-preset-apply').addEventListener('click', () => { if (ed.r && ed.r.pudgy) applyModelToEditor(pudgyPreset(ed.r.pudgy.kind)); });
$('#ed-preset-reset').addEventListener('click', resetPreset);

/* ---------- UI ---------- */
function setStatus(msg, pct) {
  const s = $('#status');
  s.hidden = !msg;
  $('#status-text').textContent = msg || '';
  const pr = $('#progress');
  pr.hidden = pct === undefined;
  if (pct === null) pr.removeAttribute('value');
  else if (pct !== undefined) pr.value = pct;
}
const alertStatus = (m) => setStatus(m);

function updateButtons() {
  const pending = state.photos.filter((p) => !p.processed).length;
  const b = $('#btn-detect');
  b.disabled = state.busy || !pending;
  b.textContent = state.busy ? 'Analyse en cours…'
    : pending ? `Détecter les visages (${pending} photo${pending > 1 ? 's' : ''})`
    : 'Détecter les visages';
  const ready = state.photos.filter((p) => state.results.has(p.id)).length;
  const sa = $('#btn-save-all');
  if (!sa._files) {
    sa.disabled = !ready;
    sa.textContent = ready ? `Tout enregistrer (${ready})` : 'Tout enregistrer';
  }
  $('#cluster-row').hidden = !state.faces.length;
}

function renderPhotos() {
  const box = $('#photos');
  box.replaceChildren(...state.photos.map((p) => {
    let tag = null;
    if (p.error) tag = el('span', { class: 'tag err', text: p.error });
    else if (p.processed) tag = el('span', { class: 'tag', text: `${p.faceCount || 0} visage${(p.faceCount || 0) > 1 ? 's' : ''}` });
    return el('div', { class: 'thumb' + (p.processed ? '' : ' pending'), title: p.name },
      p.thumb ? el('img', { src: p.thumb, alt: p.name }) : null,
      tag,
      el('button', { class: 'x', 'aria-label': 'Retirer ' + p.name, text: '×', onclick: () => removePhoto(p.id) }));
  }));
  $('#photo-count').textContent = state.photos.length ? String(state.photos.length) : '';
  updateButtons();
}

function renderRepls() {
  const box = $('#repls');
  box.replaceChildren(...state.repls.map((r) => {
    let tag = null;
    if (r.error) tag = el('span', { class: 'tag err', text: r.error });
    else if (r.bg.mode !== 'none') tag = el('span', { class: 'tag face-on', text: 'sans fond' });
    return el('div', { class: 'thumb repl' + (r.ready ? '' : ' pending'), title: r.name },
      el('button', { class: 'open', 'aria-label': 'Ajuster ' + r.name, disabled: !r.ready, onclick: () => openEditor(r.id) },
        r.preview || r.thumb ? el('img', { src: r.preview || r.thumb, alt: r.name }) : null),
      r.ready && !r.error ? el('span', { class: 'edit-hint', text: 'Ajuster' }) : null,
      tag,
      el('button', { class: 'x', 'aria-label': 'Retirer ' + r.name, text: '×', onclick: () => removeRepl(r.id) }));
  }));
  $('#repl-count').textContent = state.repls.length ? String(state.repls.length) : '';
  $('#repl-hint').hidden = !state.repls.some((r) => r.ready);
  renderLib();
}

function faceButton(f) {
  const photo = state.photos.find((p) => p.id === f.photoId);
  return el('button', {
    class: 'face' + (state.selected.has(f.id) ? ' sel' : ''),
    title: photo ? photo.name : '',
    'aria-pressed': state.selected.has(f.id) ? 'true' : 'false',
    onclick: () => {
      if (state.selected.has(f.id)) state.selected.delete(f.id); else state.selected.add(f.id);
      renderGroups();
    },
  }, el('img', { src: f.thumb, alt: 'Visage' }));
}

function renderGroups() {
  const box = $('#groups');
  const groups = sortedGroups();
  const ignored = facesOf('ignored');
  const cards = [];
  if (!state.faces.length) {
    cards.push(el('div', { class: 'empty' },
      el('strong', { text: 'Aucun visage pour l\'instant.' }),
      el('ol', {},
        el('li', { text: 'Ajoute les photos où se trouvent les visages.' }),
        el('li', { text: 'Ajoute une ou plusieurs images de remplacement.' }),
        el('li', { text: 'Lance « Détecter les visages », vérifie les groupes, puis associe une image à chaque personne.' }))));
  }
  for (const g of groups) {
    const faces = facesOf(g.id);
    const others = groups.filter((x) => x.id !== g.id);
    const head = el('div', { class: 'group-head' },
      el('input', { class: 'name', id: 'name-' + g.id, value: g.name, 'aria-label': 'Nom de la personne', oninput: (e) => { g.name = e.target.value; refreshSelbar(); } }),
      el('span', { class: 'count', text: `${faces.length} visage${faces.length > 1 ? 's' : ''}` }),
      others.length ? el('select', {
        'aria-label': 'Fusionner avec une autre personne',
        onchange: (e) => { if (e.target.value) mergeGroups(g.id, e.target.value); },
      }, el('option', { value: '', text: 'Fusionner avec…' }), others.map((o) => el('option', { value: o.id, text: o.name }))) : null);
    const pick = el('div', { class: 'repl-pick' },
      el('span', { class: 'lbl', text: 'Remplacer par' }),
      state.repls.length
        ? el('div', { class: 'repl-row' },
            el('button', { class: 'repl-opt' + (!g.replId ? ' on' : ''), text: 'Aucun', onclick: () => { g.replId = null; renderGroups(); scheduleRender(); } }),
            state.repls.filter((r) => r.preview || r.thumb).map((r) => el('button', {
              class: 'repl-opt' + (g.replId === r.id ? ' on' : ''), title: r.name, 'aria-label': 'Remplacer par ' + r.name,
              onclick: () => { g.replId = r.id; renderGroups(); scheduleRender(); },
            }, el('img', { src: r.preview || r.thumb, alt: '' }))),
            g.replId ? el('button', { class: 'btn small adjust', text: 'Ajuster l\'image', onclick: () => openEditor(g.replId) }) : null)
        : el('span', { class: 'lbl', text: '— ajoute d\'abord des images de remplacement (étape 1)' }));
    cards.push(el('div', { class: 'group' + (g.replId ? ' has-repl' : '') }, head, el('div', { class: 'faces' }, faces.map(faceButton)), pick));
  }
  if (ignored.length) {
    cards.push(el('div', { class: 'group ignored' },
      el('div', { class: 'group-head' },
        el('strong', { text: 'Visages ignorés' }),
        el('span', { class: 'count', text: `${ignored.length} · jamais remplacés · sélectionne-les pour les restaurer` })),
      el('div', { class: 'faces' }, ignored.map(faceButton))));
  }
  box.replaceChildren(...cards);
  refreshSelbar();
}

function refreshSelbar() {
  const n = state.selected.size;
  $('#selbar').hidden = !n;
  if (!n) return;
  $('#sel-what').textContent = `${n} visage${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}`;
  const sel = $('#sel-move');
  sel.replaceChildren(el('option', { value: '', text: 'Déplacer vers…' }),
    sortedGroups().map((g) => el('option', { value: g.id, text: g.name })));
}

function drawResultsGrid() {
  const box = $('#results');
  const items = state.photos.filter((p) => p.processed && !p.error);
  if (!items.length) {
    box.replaceChildren(el('div', { class: 'empty', text: 'Les photos modifiées apparaîtront ici dès qu\'une personne aura une image de remplacement.' }));
  } else {
    box.replaceChildren(...items.map((p) => {
      const r = state.results.get(p.id);
      const changed = !!photoSig(p);
      return el('figure', { class: 'result' + (changed ? '' : ' unchanged') },
        el('button', { class: 'frame', id: 'frame-' + p.id, 'aria-label': 'Agrandir ' + p.name, onclick: () => openViewer(p.id) },
          el('img', { src: r ? r.url : (p.previewUrl || p.thumb), alt: p.name, loading: 'lazy' })),
        el('figcaption', {}, el('span', { text: changed ? p.name : 'Inchangée · ' + p.name }),
          hasRepl(p) ? el('button', { class: 'btn small', text: 'Ajuster', 'aria-label': 'Ajuster les visages de ' + p.name, onclick: () => openViewer(p.id, true) }) : null));
    }));
  }
  updateButtons();
}
function markBusy(id, on) {
  const f = document.getElementById('frame-' + id);
  if (f) f.classList.toggle('busy', on);
}
function renderAll() { renderPhotos(); renderRepls(); renderGroups(); drawResultsGrid(); }

/* ---------- Événements ---------- */
function wireDrop(zoneId, inputId, handler) {
  const zone = $(zoneId), input = $(inputId);
  input.addEventListener('change', () => { handler([...input.files]); input.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, () => zone.classList.remove('over')));
  zone.addEventListener('drop', (e) => { e.preventDefault(); handler([...(e.dataTransfer?.files || [])]); });
}
wireDrop('#drop-photos', '#in-photos', addPhotos);
wireDrop('#drop-repls', '#in-repls', addRepls);

$('#btn-detect').addEventListener('click', detect);
$('#threshold').addEventListener('input', (e) => { state.threshold = +e.target.value; $('#threshold-out').textContent = state.threshold.toFixed(2); });
$('#btn-regroup').addEventListener('click', regroupAll);

$('#lib-q').addEventListener('input', renderLib);
$('#lib-export').addEventListener('click', (e) => saveWithButton(e.currentTarget, exportLib, 'Sauvegarder dans Fichiers'));
$('#lib-import').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importLib(f); });

$('#sel-new').addEventListener('click', () => moveSelected('new'));
$('#sel-ignore').addEventListener('click', () => moveSelected('ignored'));
$('#sel-clear').addEventListener('click', () => { state.selected.clear(); renderGroups(); });
$('#sel-move').addEventListener('change', (e) => { if (e.target.value) moveSelected(e.target.value); });

$('#shape').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b) return;
  state.settings.shape = b.dataset.v;
  $('#shape').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  scheduleRender();
});
$('#scale').addEventListener('input', (e) => {
  state.settings.scale = +e.target.value;
  $('#scale-out').textContent = Math.round(state.settings.scale * 100) + ' %';
  scheduleRender();
});
$('#rotate').addEventListener('change', (e) => { state.settings.rotate = e.target.checked; scheduleRender(); });
$('#outline').addEventListener('change', (e) => { state.settings.outline = e.target.checked; scheduleRender(); });

$('#btn-save-all').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const photos = state.photos.filter((p) => state.results.has(p.id));
  saveWithButton(btn, async () => {
    const files = await buildFiles(photos);
    libSaveForPhotos(photos);
    return files;
  }, `Tout enregistrer (${photos.length})`);
});

$('#viewer-close').addEventListener('click', closeViewer);
$('#viewer-save').addEventListener('click', async () => {
  if (!viewer.fullFile) return;
  const p = viewer.photo;
  libSaveForPhotos([p]);
  await deliver([viewer.fullFile]);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#editor').hidden) closeEditor();
  else if (fx.on) finishFx();
  else if (!$('#viewer').hidden) closeViewer();
});
const showOrig = (on) => {
  const p = viewer.photo;
  if (!p) return;
  const r = state.results.get(p.id);
  $('#viewer-img').src = on ? p.previewUrl : (viewer.fullUrl || (r ? r.url : p.previewUrl));
};
const ob = $('#viewer-orig');
ob.addEventListener('pointerdown', (e) => { e.preventDefault(); showOrig(true); });
['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => ob.addEventListener(t, () => showOrig(false)));
ob.addEventListener('contextmenu', (e) => e.preventDefault());

if (typeof faceapi === 'undefined') {
  setStatus('La bibliothèque de reconnaissance n\'a pas pu être chargée (fichier vendor/face-api.js manquant ?).');
}
renderAll();

/* ---------- Hors ligne (PWA) ---------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => { $('#offline-badge').hidden = false; })
    .catch((err) => console.warn('Mode hors ligne indisponible :', err));
}
