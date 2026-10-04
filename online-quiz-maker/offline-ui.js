// offline-ui.js
// Batch 9 — plain-language offline/storage status (#offlineRow) and the Qwen model cache controls (#qwenCacheBlock).
//
// Elements are looked up by id with null guards (they live in online-quiz-maker.html; this module is not wired through dom-refs.js).
// Must be imported after qwen-ui.js in main.js, so #qwenRow's show/hide has already been set up.
//
// What "offline" means here:
//   * App files + CDN scripts  -> service worker (sw.js). "Make app available offline" asks it to fetch the extra assets that are
//                                 otherwise only cached after first use (OCR worker/core/language data, the WebLLM runtime).
//   * Qwen model weights       -> WebLLM's own Cache API stores ("webllm/model", "webllm/config", "webllm/wasm"). The service worker
//                                 deliberately does not touch them; this module only lists / downloads / deletes through WebLLM's helpers.

import {
  WEBLLM_CDN_URL,
  QWEN_PRESETS,
  getSelectedQwenPresetKey,
  detectQwenCapabilities,
  loadQwenModel,
  hasQwenModelCached,
  deleteQwenModelCache,
  getStorageEstimate,
  requestPersistentStorage,
  isStoragePersisted,
  assessQwenDownloadRisk,
  onQwenStatusChange,
} from './qwen-local.js';
import { OCR_WARM_URLS } from './doc-extraction.js';

const $ = (id) => document.getElementById(id);

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function setText(id, text) { const el = $(id); if (el) el.textContent = text; }

// ---------------------------------------------------------------------------------------------------------------------
// App-level status
// ---------------------------------------------------------------------------------------------------------------------

async function refreshAppStatus() {
  const list = $('offlineStatusList');
  if (!list) return;
  const rows = []; // { ok: true | false | null, text }
  const add = (ok, text) => rows.push({ ok, text });

  if (location.protocol === 'file:') {
    add(false, 'Opened from a file:// address. Offline mode, the service worker and in-browser Qwen need http(s):// or localhost — serve this folder (for example "python3 -m http.server") and open it from there.');
  }

  if (!('serviceWorker' in navigator)) {
    add(false, 'Offline cache: not supported by this browser.');
  } else {
    const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
    if (!reg) add(false, 'Offline cache: not set up (needs https:// or localhost).');
    else if (navigator.serviceWorker.controller) add(true, 'Offline cache: active — app files are saved on this device.');
    else add(null, 'Offline cache: installed. Reload the page once to activate it.');
  }

  try {
    const caps = await detectQwenCapabilities();
    add(caps.webgpu, caps.webgpu
      ? 'WebGPU: available — in-browser Qwen can run on this device.'
      : 'WebGPU: not available here — in-browser Qwen will not run. Use another AI provider.');
  } catch (e) { add(null, 'WebGPU: could not be checked.'); }

  const persisted = await isStoragePersisted();
  if (persisted === true) add(true, 'Storage: protected — the browser will not clear it automatically.');
  else if (persisted === false) add(null, 'Storage: the browser may clear it when space is low. Use "Protect storage" to ask it not to.');
  else add(null, 'Storage protection: not supported by this browser.');

  if (typeof navigator.onLine === 'boolean') add(navigator.onLine, navigator.onLine ? 'Network: online.' : 'Network: offline.');

  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  if (standalone) add(true, 'Running as an installed app.');

  list.textContent = '';
  for (const r of rows) {
    const li = document.createElement('li');
    li.textContent = `${r.ok === true ? '✓' : r.ok === false ? '✗' : '•'} ${r.text}`;
    list.appendChild(li);
  }
  await refreshStorageEstimate();
}

async function refreshStorageEstimate() {
  const est = await getStorageEstimate();
  setText('storageEstimate', est
    ? `Storage used by this site: ${fmtBytes(est.usage)} of about ${fmtBytes(est.quota)} available (browser estimate).`
    : 'Storage usage: this browser does not report an estimate.');
}

// ---------------------------------------------------------------------------------------------------------------------
// Service worker conversation
// ---------------------------------------------------------------------------------------------------------------------

function askServiceWorker(sw, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('The offline cache did not answer in time.')), timeoutMs);
    channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
    sw.postMessage(message, [channel.port2]);
  });
}

async function prepareOffline() {
  const btn = $('offlinePrepareBtn');
  const say = (t) => setText('offlineMessage', t);
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') {
    say('Offline mode is not available here. Open the app from https:// or localhost in a browser that supports service workers.');
    return;
  }
  if (btn) btn.disabled = true;
  try {
    say('Checking the offline cache…');
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(() => resolve(null), 6000)),
    ]);
    if (!reg || !reg.active) { say('The offline cache is not active yet. Reload the page once and try again.'); return; }

    // Load the Qwen runtime through the page first: its nested imports are only cached when something actually requests them.
    say('Saving the in-browser AI runtime…');
    await hasQwenModelCached().catch(() => null);

    say('Saving OCR files and the AI runtime for offline use…');
    const reply = await askServiceWorker(reg.active, { type: 'WARM', urls: [...OCR_WARM_URLS, WEBLLM_CDN_URL] }, 180000);
    const report = (reply && reply.report) || [];
    const failed = report.filter((r) => !r.ok);
    say(failed.length
      ? `Saved ${report.length - failed.length} of ${report.length} extra files. Could not fetch: ${failed.map((f) => f.url.split('/').slice(-1)[0]).join(', ')}. Check your connection and try again.`
      : `Done — ${report.length} extra files saved. The app, OCR and the AI runtime can now start without a network. (Qwen model weights are saved separately, below.)`);
  } catch (err) {
    say(`Could not finish: ${(err && err.message) || err}`);
  } finally {
    if (btn) btn.disabled = false;
    refreshAppStatus();
  }
}

async function protectStorage() {
  const granted = await requestPersistentStorage();
  setText('offlineMessage', granted === true
    ? 'Storage is now protected from automatic clearing.'
    : granted === false
      ? 'The browser declined. Installing the app or using it regularly often helps; some browsers never grant this.'
      : 'This browser does not support protecting storage.');
  refreshAppStatus();
}

// ---------------------------------------------------------------------------------------------------------------------
// Qwen model cache controls
// ---------------------------------------------------------------------------------------------------------------------

function qwenRowVisible() {
  const row = $('qwenRow');
  return !!row && !row.classList.contains('hidden');
}

async function refreshQwenCache() {
  if (!$('qwenCacheStatus') || !qwenRowVisible()) return;
  const preset = QWEN_PRESETS[getSelectedQwenPresetKey()];
  setText('qwenCacheStatus', 'Checking whether this model is saved on this device…');
  const cached = await hasQwenModelCached();
  setText('qwenCacheStatus', cached === true
    ? `${preset.params} model: saved on this device — it works offline.`
    : cached === false
      ? `${preset.params} model: not downloaded yet.`
      : `${preset.params} model: could not check (the AI runtime has not loaded — are you offline for the first time?).`);
  const del = $('qwenDeleteCacheBtn');
  if (del) del.disabled = cached !== true;
}

async function downloadModel() {
  const btn = $('qwenDownloadBtn');
  const key = getSelectedQwenPresetKey();
  const preset = QWEN_PRESETS[key];
  const risk = await assessQwenDownloadRisk(key);
  if (risk.warn) {
    const ok = window.confirm(`Before downloading the ${preset.params} model:\n\n• ${risk.reasons.join('\n• ')}\n\nThe download is several hundred MB or more. Continue?`);
    if (!ok) return;
  }
  if (btn) btn.disabled = true;
  try {
    await loadQwenModel(key); // progress is shown by the Qwen panel and the import status line
    setText('offlineMessage', `${preset.params} model downloaded and loaded — it now works offline.`);
  } catch (err) {
    // shown on the message line: refreshQwenCache() below rewrites #qwenCacheStatus and would erase it
    if (!(err && err.isCancelled)) setText('offlineMessage', `Model download failed: ${(err && err.message) || err}`);
  } finally {
    if (btn) btn.disabled = false;
    refreshQwenCache();
    refreshStorageEstimate();
  }
}

async function deleteModel() {
  const key = getSelectedQwenPresetKey();
  const preset = QWEN_PRESETS[key];
  if (!window.confirm(`Delete the saved ${preset.params} model from this device? It will have to be downloaded again before Qwen works offline.`)) return;
  const btn = $('qwenDeleteCacheBtn');
  if (btn) btn.disabled = true;
  try {
    const before = await getStorageEstimate();
    const res = await deleteQwenModelCache(key);
    setText('qwenCacheStatus', res.deleted ? `${preset.params} model deleted.` : `Nothing to delete for the ${preset.params} model.`);
    // Browsers update the estimate lazily; check again after a moment.
    setTimeout(async () => {
      const after = await getStorageEstimate();
      if (before && after) setText('offlineMessage', `Storage used: ${fmtBytes(before.usage)} → ${fmtBytes(after.usage)} (the browser's estimate can lag a few seconds).`);
      refreshStorageEstimate();
    }, 1500);
  } catch (err) {
    setText('qwenCacheStatus', `Could not delete: ${(err && err.message) || err}`);
  } finally {
    refreshQwenCache();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------------------------------

function init() {
  const on = (id, evt, fn) => { const el = $(id); if (el) el.addEventListener(evt, fn); };
  on('offlinePrepareBtn', 'click', prepareOffline);
  on('persistStorageBtn', 'click', protectStorage);
  on('qwenDownloadBtn', 'click', downloadModel);
  on('qwenDeleteCacheBtn', 'click', deleteModel);
  on('qwenModelSelect', 'change', () => setTimeout(refreshQwenCache, 0));
  on('providerSelect', 'change', () => setTimeout(refreshQwenCache, 50));

  window.addEventListener('online', refreshAppStatus);
  window.addEventListener('offline', refreshAppStatus);
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('controllerchange', refreshAppStatus);

  // qwen-ui.js shows/hides #qwenRow; refresh the cache line whenever it becomes visible.
  const row = $('qwenRow');
  if (row && 'MutationObserver' in window) {
    new MutationObserver(() => { if (qwenRowVisible()) refreshQwenCache(); }).observe(row, { attributes: true, attributeFilter: ['class'] });
  }
  onQwenStatusChange((s) => { if (s.state === 'ready') refreshQwenCache(); });

  refreshAppStatus();
  refreshQwenCache();
}

init();
