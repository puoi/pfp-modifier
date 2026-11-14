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
function addRepls(files) {
  for (const file of files) {
    if (!isImage(file)) continue;
    const r = { id: nid('r'), file, name: file.name, thumb: null, src: null, face: null, useFace: false, ready: false, error: null };
    state.repls.push(r);
    replChain = replChain.then(() => prepareRepl(r));
  }
  renderRepls();
}
async function prepareRepl(r) {
  if (!state.repls.includes(r)) return;
  try {
    const img = await loadImage(r.file);
    r.src = fitCanvas(img, img.naturalWidth, img.naturalHeight, 1024);
    freeImage(img);
    r.thumb = coverThumb(r.src, 200);
    r.ready = true;
    renderRepls(); renderGroups();
    // Si l'image contient un visage, on cadre dessus (désactivable).
    try {
      await loadModels();
      const dets = await faceapi.detectAllFaces(r.src, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 })).withFaceLandmarks();
      if (dets.length) {
        const d = dets.reduce((a, b) => (a.detection.box.area > b.detection.box.area ? a : b));
        const b = d.detection.box;
        r.face = { cx: b.x + b.width / 2, cy: b.y + b.height / 2, size: Math.max(b.width, b.height), angle: eyeAngle(d.landmarks) };
        r.useFace = true;
      }
      if (!state.busy) setStatus('');
    } catch (e) { /* pas grave : centrage simple */ }
  } catch (err) {
    r.error = 'Illisible';
  }
  r.patch = null;
  renderRepls(); renderGroups(); scheduleRender();
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
function getPatch(r) {
  const scale = state.settings.scale;
  const key = r.useFace && r.face ? 'f' + scale : 'c';
  if (r.patch && r.patchKey === key) return r.patch;
  const N = 768;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d');
  if (r.useFace && r.face) {
    const s = r.face.size * scale;
    ctx.translate(N / 2, N / 2);
    ctx.scale(N / s, N / s);
    ctx.rotate(-r.face.angle);
    ctx.drawImage(r.src, -r.face.cx, -r.face.cy);
  } else {
    const s = Math.min(r.src.width, r.src.height);
    ctx.drawImage(r.src, (r.src.width - s) / 2, (r.src.height - s) / 2, s, s, 0, 0, N, N);
  }
  r.patch = c; r.patchKey = key;
  return c;
}
function shapePath(ctx, shape, s) {
  const h = s / 2;
  ctx.beginPath();
  if (shape === 'circle') ctx.arc(0, 0, h, 0, Math.PI * 2);
  else if (shape === 'ellipse') ctx.ellipse(0, 0, h * 0.84, h, 0, 0, Math.PI * 2);
  else if (shape === 'rounded') {
    const rr = s * 0.22;
    ctx.moveTo(-h + rr, -h);
    ctx.arcTo(h, -h, h, h, rr); ctx.arcTo(h, h, -h, h, rr);
    ctx.arcTo(-h, h, -h, -h, rr); ctx.arcTo(-h, -h, h, -h, rr);
    ctx.closePath();
  } else ctx.rect(-h, -h, s, s);
}
const replFor = (f) => {
  const g = state.groups.find((x) => x.id === f.groupId);
  const r = g && g.replId && state.repls.find((x) => x.id === g.replId);
  return r && r.ready ? r : null;
};
function photoSig(p) {
  const st = state.settings;
  const parts = state.faces.filter((f) => f.photoId === p.id).map((f) => {
    const r = replFor(f);
    return r ? `${f.id}:${r.id}:${r.useFace ? 1 : 0}` : '';
  }).filter(Boolean);
  if (!parts.length) return '';
  return `${st.shape}|${st.scale}|${st.rotate}|${st.outline}|${parts.join(',')}`;
}
async function renderPhoto(p, full) {
  const img = await loadImage(full ? p.file : p.previewBlob);
  const c = fitCanvas(img, img.naturalWidth, img.naturalHeight, full ? Infinity : PREVIEW_SIDE);
  freeImage(img);
  const k = c.width / p.w;
  const ctx = c.getContext('2d');
  const st = state.settings;
  for (const f of state.faces) {
    if (f.photoId !== p.id) continue;
    const r = replFor(f);
    if (!r) continue;
    const patch = getPatch(r);
    const s = Math.max(f.box.w, f.box.h) * st.scale * k;
    ctx.save();
    ctx.translate((f.box.x + f.box.w / 2) * k, (f.box.y + f.box.h / 2) * k);
    if (st.rotate) ctx.rotate(f.angle);
    shapePath(ctx, st.shape, s);
    ctx.save();
    ctx.clip();
    ctx.drawImage(patch, -s / 2, -s / 2, s, s);
    ctx.restore();
    if (st.outline) {
      ctx.lineWidth = Math.max(2, s * 0.03);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    ctx.restore();
  }
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
async function openViewer(id) {
  const p = state.photos.find((x) => x.id === id);
  const r = state.results.get(id);
  if (!p) return;
  viewer.photo = p; viewer.fullFile = null;
  const token = ++viewer.token;
  if (viewer.fullUrl) { URL.revokeObjectURL(viewer.fullUrl); viewer.fullUrl = null; }
  $('#viewer-img').src = r ? r.url : p.previewUrl;
  $('#viewer-save').hidden = !r;
  $('#viewer-save').textContent = 'Préparation…';
  $('#viewer-save').disabled = true;
  $('#viewer').hidden = false;
  document.body.style.overflow = 'hidden';
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
  $('#viewer').hidden = true;
  document.body.style.overflow = '';
  if (viewer.fullUrl) { URL.revokeObjectURL(viewer.fullUrl); viewer.fullUrl = null; }
  $('#viewer-img').removeAttribute('src');
}

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
    else if (r.face) tag = el('button', {
      class: 'tag ' + (r.useFace ? 'face-on' : 'face-off'),
      title: 'Cadrer sur le visage détecté dans cette image',
      text: r.useFace ? 'cadré visage' : 'image entière',
      onclick: () => { r.useFace = !r.useFace; r.patch = null; renderRepls(); scheduleRender(); },
    });
    return el('div', { class: 'thumb' + (r.ready ? '' : ' pending'), title: r.name },
      r.thumb ? el('img', { src: r.thumb, alt: r.name }) : null,
      tag,
      el('button', { class: 'x', 'aria-label': 'Retirer ' + r.name, text: '×', onclick: () => removeRepl(r.id) }));
  }));
  $('#repl-count').textContent = state.repls.length ? String(state.repls.length) : '';
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
            state.repls.filter((r) => r.thumb).map((r) => el('button', {
              class: 'repl-opt' + (g.replId === r.id ? ' on' : ''), title: r.name, 'aria-label': 'Remplacer par ' + r.name,
              onclick: () => { g.replId = r.id; renderGroups(); scheduleRender(); },
            }, el('img', { src: r.thumb, alt: '' }))))
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
        el('figcaption', {}, el('span', { text: changed ? p.name : 'Inchangée · ' + p.name })));
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
  saveWithButton(btn, () => buildFiles(photos), `Tout enregistrer (${photos.length})`);
});

$('#viewer-close').addEventListener('click', closeViewer);
$('#viewer-save').addEventListener('click', async () => {
  if (viewer.fullFile) await deliver([viewer.fullFile]);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#viewer').hidden) closeViewer(); });
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
