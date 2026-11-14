/* Service worker : met toute l'app en cache pour qu'elle marche hors ligne. */
const VERSION = 'pfp-v5';
const FILES = [
  './',
  'index.html',
  'app.js',
  'bg.js',
  'manifest.webmanifest',
  'vendor/face-api.js',
  'vendor/ort/ort.wasm.min.js',
  'vendor/ort/ort-wasm-simd-threaded.mjs',
  'vendor/ort/ort-wasm-simd-threaded.wasm',
  'models/bg/u2netp.onnx',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'models/ssd_mobilenetv1_model-weights_manifest.json',
  'models/ssd_mobilenetv1_model.bin',
  'models/face_landmark_68_model-weights_manifest.json',
  'models/face_landmark_68_model.bin',
  'models/face_recognition_model-weights_manifest.json',
  'models/face_recognition_model.bin',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return res;
    }))
  );
});
