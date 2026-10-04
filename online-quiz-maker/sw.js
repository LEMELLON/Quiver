// sw.js — Batch 9: offline app shell + runtime cache for the pinned CDN assets.
//
// Strategy
//   * Same-origin GET (the app's own HTML/JS/CSS):  stale-while-revalidate. Anything the page loads while online is stored, so
//     the app works offline after ONE online session even for modules not listed in SHELL_URLS.
//   * Allow-listed CDN hosts (Tailwind, Google Fonts, pdf.js, JSZip, Tesseract, jsDelivr incl. the WebLLM + pptx ESM): cache-first.
//   * Everything else passes straight through to the network. That deliberately includes the Qwen model WEIGHTS (Hugging Face) and
//     the compiled model libraries: WebLLM keeps those in its own Cache API stores, and they are huge and use Range requests.
//     It also includes every Gemini/OpenAI call (POST) and any local OpenAI-compatible endpoint.
//
// Must be served over http(s):// or localhost. Service workers do not run from file://.
// Bump CACHE_VERSION whenever SHELL_URLS or the pinned CDN URLs change.

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `quizmaker-shell-${CACHE_VERSION}`;
const CDN_CACHE = `quizmaker-cdn-${CACHE_VERSION}`;

// Best-effort list (missing names are skipped, see install). Unlisted same-origin files are still cached the first time they load.
const SHELL_URLS = [
  './',
  './online-quiz-maker.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './styles.css',
  './config.js',
  './gemini-classifier.js',
  './main.js',
  './core-state.js', './dom-refs.js', './classification-meta.js', './shared-constants.js',
  './seed-api-key.js', './ai-credentials-and-models.js', './qwen-ui.js', './offline-ui.js',
  './question-model.js', './status-helpers.js', './editor-render.js', './doc-extraction.js',
  './text-normalize.js', './highlighting.js', './layout-formatting.js', './ai-provider.js',
  './qwen-local.js', './qwen-worker.js', './selection-toolbar.js', './variant-generation.js',
  './snippet-question-generation.js', './ai-prompt-builders.js', './ai-api-calls.js',
  './doc-pane-navigation.js', './quiz-export.js', './batch-scan.js', './pptx-render.js', './pdf-render.js',
];

// Small CDN files the app cannot start without. Fetched at install.
const CDN_CORE_URLS = [
  'https://cdn.tailwindcss.com/',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Inter:wght@400;500;600;700&display=swap',
];

const CDN_HOSTS = new Set([
  'cdn.tailwindcss.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'tessdata.projectnaptha.com',
  'unpkg.com',
]);

async function addAllSettled(cacheName, urls, { cors = false } = {}) {
  const cache = await caches.open(cacheName);
  const results = await Promise.allSettled(urls.map(async (url) => {
    const req = new Request(url, cors ? { mode: 'cors' } : undefined);
    const res = await fetch(req);
    if (!res || !(res.ok || res.type === 'opaque')) throw new Error(`${url} -> ${res && res.status}`);
    await cache.put(req, res);
  }));
  return results.map((r, i) => ({ url: urls[i], ok: r.status === 'fulfilled', error: r.status === 'rejected' ? String(r.reason) : '' }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await addAllSettled(SHELL_CACHE, SHELL_URLS);                 // a 404 here must not fail the install
    await addAllSettled(CDN_CACHE, CDN_CORE_URLS, { cors: true });
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, CDN_CACHE]);
    for (const name of await caches.keys()) {
      if (name.startsWith('quizmaker-') && !keep.has(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

async function staleWhileRevalidate(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: false });
  const network = fetch(request).then((res) => {
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  if (cached) { network.catch(() => {}); return cached; }
  const res = await network;
  if (res) return res;
  if (fallbackUrl) { const fb = await cache.match(fallbackUrl); if (fb) return fb; }
  return new Response('Offline and not cached yet.', { status: 503, statusText: 'Offline' });
}

async function cacheFirst(request) {
  const cache = await caches.open(CDN_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('range')) return; // never intercept Range requests (model weights, media)
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/sw.js')) return; // let the browser handle SW updates itself
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE, req.mode === 'navigate' ? './online-quiz-maker.html' : null));
    return;
  }
  if (CDN_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(req).catch(() => new Response('Offline and not cached yet.', { status: 503, statusText: 'Offline' })));
  }
});

// Page -> SW messages.
//   { type: 'WARM', urls: [...] }  fetch + cache extra CDN assets (OCR core/lang data, WebLLM runtime) ahead of going offline.
//   { type: 'STATUS' }             reply with the number of cached entries per cache.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  if (data.type === 'WARM' && Array.isArray(data.urls)) {
    event.waitUntil((async () => {
      const allowed = data.urls.filter((u) => { try { return CDN_HOSTS.has(new URL(u).hostname); } catch (e) { return false; } });
      const report = await addAllSettled(CDN_CACHE, allowed, { cors: true });
      if (port) port.postMessage({ type: 'WARM_DONE', report });
    })());
  } else if (data.type === 'STATUS') {
    event.waitUntil((async () => {
      const out = {};
      for (const name of [SHELL_CACHE, CDN_CACHE]) out[name] = (await (await caches.open(name)).keys()).length;
      if (port) port.postMessage({ type: 'STATUS', counts: out });
    })());
  }
});
