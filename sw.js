/* Cipher Shift offline support: keeps every game file in a versioned cache and serves the game from it.
   VERSION and FILES are written by tools/make-sw.mjs; rerun it after changing anything in dist/. */
'use strict';
const VERSION = '879bdf1190e05fd8';
const FILES = [
  'app.js',
  'fonts/barlow-condensed-500.woff2',
  'fonts/barlow-condensed-600.woff2',
  'fonts/barlow-condensed-700.woff2',
  'fonts/ibm-plex-mono-400.woff2',
  'fonts/ibm-plex-mono-500.woff2',
  'fonts/ibm-plex-mono-600.woff2',
  'fonts/space-grotesk-variable.woff2',
  'icons/apple-touch-icon.png',
  'icons/favicon-16.png',
  'icons/favicon-32.png',
  'icons/favicon.svg',
  'icons/icon-1024.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  './',
  'logic.js',
  'manifest.webmanifest',
  'save.js',
  'sound.js',
  'textures/grain.png',
];
const CACHE = 'cipher-shift-' + VERSION;

// Fetch a complete copy, bypassing the HTTP cache so a release never mixes old and new files.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

// Drop copies from earlier releases, then take over open pages.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('cipher-shift-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Cache first: the stored release answers everything, so the game starts the same with or without a connection.
// Any page inside the game's folder (including ./?debug) is the game page. Anything not stored goes to the network.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  const key = request.mode === 'navigate' ? self.registration.scope : request;
  event.respondWith(
    caches.open(CACHE)
      .then((cache) => cache.match(key, { ignoreSearch: request.mode === 'navigate' }))
      .then((hit) => hit || fetch(request)),
  );
});
