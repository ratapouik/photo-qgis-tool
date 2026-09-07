// Relevé — service worker : l'appli et ses librairies restent disponibles hors-ligne.
//
// Deux régimes, parce que les deux familles de fichiers ne vieillissent pas de la
// même façon :
//
//   — les fichiers de l'appli (même origine) sont servis depuis le cache puis
//     rafraîchis en arrière-plan. Le lancement reste instantané et fonctionne hors
//     réseau, et une mise en ligne est reprise au lancement suivant sans que
//     personne ait à toucher à ce fichier. Le cache-d'abord pur qu'on avait avant
//     figeait l'appli : sans changement ici, un correctif publié n'atteignait
//     jamais un téléphone déjà installé.
//
//   — les librairies tierces sont épinglées à une version dans leur URL
//     (jspdf@4.2.1…). Leur contenu ne change donc jamais : cache d'abord, sans
//     revalidation, pour ne pas retélécharger 400 Ko de données mobiles à chaque
//     lancement.
const CACHE = 'releve-v3';
const CORE = ['./', './index.html', './manifest.webmanifest', './support.js', './ds/styles.css', './ds/_ds_bundle.js', './icon-192.png', './icon-512.png', '../compte-rendu.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Ce qui mérite d'être gardé. Une réponse en erreur n'en fait pas partie : mise en
// cache, elle y restait pour de bon et l'appli servait éternellement le 404 d'une
// mise en ligne encore en cours de propagation. Les réponses opaques (scripts
// tiers, polices) ne laissent pas lire leur statut ; on les garde, c'est tout
// l'intérêt du mode hors-ligne.
const worthKeeping = res => res && (res.ok || res.type === 'opaque');

function remember(req, res) {
  if (!worthKeeping(res)) return;
  const copy = res.clone();
  return caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const sameOrigin = new URL(req.url).origin === self.location.origin;

  e.respondWith(
    caches.match(req).then(hit => {
      const fromNetwork = fetch(req)
        .then(res => { e.waitUntil(remember(req, res)); return res; })
        .catch(() => hit);

      // Librairie tierce déjà connue : son URL porte sa version, rien à revalider.
      if (hit && !sameOrigin) return hit;
      // Fichier de l'appli : réponse immédiate depuis le cache, mise à jour derrière.
      if (hit) { e.waitUntil(fromNetwork.catch(() => {})); return hit; }
      return fromNetwork;
    })
  );
});
