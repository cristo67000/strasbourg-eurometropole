'use strict';
/*
 * Service worker : app hors ligne complète.
 *
 * Deux caches distincts :
 *  - APP_CACHE (versionné par build, cf. data/precache.json) : app shell,
 *    styles, glyphes, sprites, JSON de données, photos de musées.
 *  - TILES_CACHE (stable, jamais purgé automatiquement) : le fond de carte
 *    `data/tiles.pmtiles`, téléchargé à la demande par pwa.js (bouton
 *    « installer la carte hors ligne »), PAS au premier chargement — 30 Mo,
 *    trop lourd pour un pré-cache systématique.
 *
 * pmtiles.js lit le fichier par requêtes HTTP Range (petits fragments,
 * beaucoup de requêtes pendant qu'on navigue sur la carte). Le Cache Storage
 * ne sait pas satisfaire un Range sur une entrée complète : on garde donc le
 * fichier en mémoire (ArrayBuffer) une fois chargé du cache, et on découpe
 * nous-mêmes la plage demandée à chaque requête.
 */

const CLE_TUILES = 'data/tiles.pmtiles';
const TILES_CACHE = 'strasbourg-tuiles-v1';
let APP_CACHE = 'strasbourg-app'; // remplacé par le build réel à l'installation

let tuilesBuffer = null;
let tuilesChargement = null;

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const reponse = await fetch('data/precache.json', { cache: 'reload' });
      const { build, fichiers } = await reponse.json();
      APP_CACHE = 'strasbourg-app-' + build;
      const cache = await caches.open(APP_CACHE);
      // `cache: 'reload'` contourne le cache HTTP du navigateur, sinon
      // addAll() peut figer une version périmée dans le cache neuf.
      await cache.addAll(fichiers.map((u) => new Request(u, { cache: 'reload' })));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const cles = await caches.keys();
      await Promise.all(
        cles
          .filter((k) => k.startsWith('strasbourg-app-') && k !== APP_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'tuiles-modifiees') {
    tuilesBuffer = null;
    tuilesChargement = null;
  }
});

self.addEventListener('fetch', (e) => {
  const request = e.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/' + CLE_TUILES)) {
    e.respondWith(repondreTuiles(request));
    return;
  }

  if (request.mode === 'navigate') {
    e.respondWith(reseauDabordNavigation(request));
    return;
  }

  const lourd = /\/(lib|assets|icons|img)\//.test(url.pathname);
  e.respondWith(lourd ? cacheDabord(request) : reseauDabord(request));
});

async function cacheDabord(request) {
  const cache = await caches.open(APP_CACHE);
  const encache = await cache.match(request);
  if (encache) return encache;
  const reponse = await fetch(request);
  if (reponse.ok) cache.put(request, reponse.clone());
  return reponse;
}

async function reseauDabord(request) {
  const cache = await caches.open(APP_CACHE);
  try {
    const reponse = await fetch(request, { cache: 'no-cache' });
    if (reponse.ok) cache.put(request, reponse.clone());
    return reponse;
  } catch (err) {
    const encache = await cache.match(request, { ignoreSearch: true });
    if (encache) return encache;
    throw err;
  }
}

async function reseauDabordNavigation(request) {
  const cache = await caches.open(APP_CACHE);
  try {
    const reponse = await fetch(request);
    if (reponse.ok) cache.put('index.html', reponse.clone());
    return reponse;
  } catch (err) {
    const secours = await cache.match('index.html');
    if (secours) return secours;
    throw err;
  }
}

async function obtenirBufferTuiles() {
  if (tuilesBuffer) return tuilesBuffer;
  if (!tuilesChargement) {
    tuilesChargement = (async () => {
      const cache = await caches.open(TILES_CACHE);
      const reponse = await cache.match(CLE_TUILES);
      if (!reponse) return null;
      tuilesBuffer = await reponse.arrayBuffer();
      return tuilesBuffer;
    })();
  }
  return tuilesChargement;
}

async function repondreTuiles(request) {
  const buffer = await obtenirBufferTuiles();
  if (!buffer) {
    // pas encore installée hors ligne : réseau direct, Range géré nativement
    return fetch(request);
  }
  const rangeHeader = request.headers.get('Range');
  const enTetes = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  if (!rangeHeader) {
    return new Response(buffer, {
      headers: { ...enTetes, 'Content-Length': String(buffer.byteLength) },
    });
  }
  const correspondance = /bytes=(\d+)-(\d+)?/.exec(rangeHeader);
  if (!correspondance) {
    return new Response(buffer, { status: 200, headers: enTetes });
  }
  const total = buffer.byteLength;
  const debut = parseInt(correspondance[1], 10);
  const fin = correspondance[2] ? Math.min(parseInt(correspondance[2], 10), total - 1) : total - 1;
  const morceau = buffer.slice(debut, fin + 1);
  return new Response(morceau, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      ...enTetes,
      'Content-Range': `bytes ${debut}-${fin}/${total}`,
      'Content-Length': String(morceau.byteLength),
    },
  });
}
