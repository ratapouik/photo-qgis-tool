// Relevé — service worker : l'appli et ses librairies restent disponibles hors-ligne.
const CACHE = 'releve-v2';
const CORE = ['./', './index.html', './manifest.webmanifest', './support.js', './ds/styles.css', './ds/_ds_bundle.js', './icon-192.png', './icon-512.png', '../compte-rendu.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Cache d'abord pour tout ce qui a déjà été vu (y compris jsPDF et les
// librairies esm.sh chargées à la première utilisation de l'export), réseau
// ensuite.
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  e.respondWith(
    caches.match(r).then(hit => {
      if (hit) return hit;
      return fetch(r).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(r, copy)).catch(() => {});
        return res;
      }).catch(() => hit);
    })
  );
});
