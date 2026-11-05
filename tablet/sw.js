/*
 * Fa funzionare l'app senza rete: conserva i file dell'applicazione sul tablet.
 * Mostra subito la copia salvata e intanto, se c'è rete, la aggiorna per l'apertura successiva.
 * Non tocca le chiamate verso Google (altro indirizzo) né i dati, che stanno in IndexedDB.
 */
const CACHE = 'rapportino-app-1';
const FILE = [
  './', './index.html', './app.js', './manifest.webmanifest',
  './icone/icona-180.png', './icone/icona-192.png', './icone/icona-512.png',
  '../comune/logica.js', '../comune/stile.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomi) => Promise.all(nomi.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const salvata = await cache.match(e.request, { ignoreSearch: true });
    const dallaRete = fetch(e.request).then((r) => {
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    });
    if (salvata) { dallaRete.catch(() => {}); return salvata; }
    return dallaRete;
  })());
});
