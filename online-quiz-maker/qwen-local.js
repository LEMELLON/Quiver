// qwen-local.js
// Batch 8 — in-browser Qwen engine (WebLLM / WebGPU, running in a Web Worker so the UI thread never blocks).
//
// Public API (used by ai-provider.js, qwen-ui.js and ai-api-calls.js):
//   detectQwenCapabilities()                      -> { webgpu, shaderF16, mobile, reason }
//   loadQwenModel(presetKey?, onProgress?)        -> Promise<void>  (idempotent; a second load of the same model is a no-op)
//   qwenGenerate(system, user, { json, maxTokens, temperature, signal }) -> Promise<string>
//   unloadQwenModel()                             -> Promise<void>
//   getQwenStatus() / onQwenStatusChange(fn)      -> { state: 'idle'|'loading'|'ready'|'generating'|'error', ... }
//   cancelQwen()                                  -> aborts the current load wait / generation promptly
//   QWEN_PRESETS, get/setSelectedQwenPresetKey, qwenLayoutFormattingEnabled/setQwenLayoutFormattingEnabled
//   getQwenContextWindow(), computePageBudgetChars(), planPageChunks()   (context-window chunking helpers for generateQuestionsWithAI)
//   Batch 9: hasQwenModelCached(), deleteQwenModelCache(), getStorageEstimate(), requestPersistentStorage(), isStoragePersisted(),
//            assessQwenDownloadRisk()   (cache management + low-memory / metered-data warning; used by offline-ui.js)
//
// Runtime: WebLLM only. The transformers.js (WASM) fallback listed as "best-effort" in the Batch 8 spec is NOT implemented;
// without WebGPU the UI shows a clear message and points at the OpenAI-compatible endpoint provider instead.
//
// The WebLLM library is imported lazily from a pinned CDN URL, with a promise cache that is cleared on failure so a flaky network
// can be retried (same pattern as pptx-render.js). qwen-worker.js MUST import the same pinned version.

import { setParseStatus } from './status-helpers.js';

const WEBLLM_VERSION = '0.2.85';
const WEBLLM_CDN_URL = `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${WEBLLM_VERSION}/+esm`;
const QWEN_WORKER_URL = new URL('./qwen-worker.js', import.meta.url);

const LS_PRESET_KEY = 'quizMaker.qwenBrowserModel';
const LS_LAYOUT_KEY = 'quizMaker.qwenFormatLayout';

// Prebuilt MLC model ids verified against WebLLM 0.2.85's prebuilt config. All have a 4096-token context window.
// `vramMB` is the figure WebLLM publishes (GPU memory needed). WebLLM does NOT publish download sizes, so labels show memory only.
// q4f16 needs the WebGPU `shader-f16` feature; q4f32 is the slightly larger fallback for GPUs without it.
const QWEN_PRESETS = {
  small: {
    key: 'small', label: 'Qwen2.5 0.5B — fastest, lowest quality', params: '0.5B',
    idF16: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', idF32: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC',
    vramMB: 945, contextWindow: 4096, desktopOnly: false,
  },
  medium: {
    key: 'medium', label: 'Qwen2.5 1.5B — balanced (recommended on desktop)', params: '1.5B',
    idF16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', idF32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    vramMB: 1630, contextWindow: 4096, desktopOnly: false,
  },
  large: {
    key: 'large', label: 'Qwen2.5 3B — better quality, slower', params: '3B',
    idF16: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', idF32: 'Qwen2.5-3B-Instruct-q4f32_1-MLC',
    vramMB: 2505, contextWindow: 4096, desktopOnly: false,
  },
  xlarge: {
    key: 'xlarge', label: 'Qwen2.5 7B — best quality, needs a strong GPU', params: '7B',
    idF16: 'Qwen2.5-7B-Instruct-q4f16_1-MLC', idF32: 'Qwen2.5-7B-Instruct-q4f32_1-MLC',
    vramMB: 5107, contextWindow: 4096, desktopOnly: true,
  },
};
const PRESET_ORDER = ['small', 'medium', 'large', 'xlarge'];

function formatPresetLabel(preset) {
  const gb = preset.vramMB >= 1000 ? `${(preset.vramMB / 1024).toFixed(1)} GB` : `${preset.vramMB} MB`;
  return `${preset.label} (~${gb} GPU memory)`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Persistence / device helpers
// ---------------------------------------------------------------------------------------------------------------------

function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* storage unavailable: ignore */ } }

function isLikelyMobileDevice() {
  try {
    if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')) return true;
    if (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4) return true;
  } catch (e) { /* ignore */ }
  return false;
}

function getSelectedQwenPresetKey() {
  const stored = lsGet(LS_PRESET_KEY);
  if (stored && QWEN_PRESETS[stored]) return stored;
  return isLikelyMobileDevice() ? 'small' : 'medium';
}

function setSelectedQwenPresetKey(key) {
  if (QWEN_PRESETS[key]) lsSet(LS_PRESET_KEY, key);
}

// Layout formatting (formatAllPagesLayout) is skipped for qwen-browser on import unless this is on (decision D12).
function qwenLayoutFormattingEnabled() { return lsGet(LS_LAYOUT_KEY) === '1'; }
function setQwenLayoutFormattingEnabled(on) { lsSet(LS_LAYOUT_KEY, on ? '1' : '0'); }

// ---------------------------------------------------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------------------------------------------------

let adapterInfoCache = null; // { webgpu, shaderF16, reason }

async function probeAdapter() {
  if (adapterInfoCache) return adapterInfoCache;
  let info;
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      info = { webgpu: false, shaderF16: false, reason: 'This browser does not expose WebGPU (navigator.gpu is missing).' };
    } else {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        info = { webgpu: false, shaderF16: false, reason: 'WebGPU is present but no GPU adapter is available (blocked, disabled or unsupported hardware).' };
      } else {
        info = { webgpu: true, shaderF16: !!(adapter.features && adapter.features.has && adapter.features.has('shader-f16')), reason: '' };
      }
    }
  } catch (e) {
    info = { webgpu: false, shaderF16: false, reason: `WebGPU check failed: ${e && e.message ? e.message : e}` };
  }
  // Only cache positive results so the user can enable WebGPU and retry without reloading the page.
  if (info.webgpu) adapterInfoCache = info;
  return info;
}

async function detectQwenCapabilities() {
  const info = await probeAdapter();
  const mobile = isLikelyMobileDevice();
  const reason = info.webgpu ? '' :
    `${info.reason} In-browser Qwen needs WebGPU (recent Chrome/Edge, or Safari 18+). Use another provider, or an OpenAI-compatible endpoint with a local Qwen server.`;
  return { webgpu: info.webgpu, shaderF16: info.shaderF16, mobile, reason };
}

// The concrete MLC model id for a preset on THIS GPU (f16 build if the adapter supports it, else f32).
async function getQwenModelIdForSelection(presetKey = getSelectedQwenPresetKey()) {
  const preset = QWEN_PRESETS[presetKey] || QWEN_PRESETS.medium;
  const info = await probeAdapter();
  return info.shaderF16 ? preset.idF16 : preset.idF32;
}

// ---------------------------------------------------------------------------------------------------------------------
// Lazy WebLLM loader (promise cache cleared on failure)
// ---------------------------------------------------------------------------------------------------------------------

let webllmPromise = null;
let webllmOverride = null; // test hook

function loadWebLlmModule() {
  if (webllmOverride) return Promise.resolve(webllmOverride);
  if (!webllmPromise) {
    webllmPromise = import(/* webpackIgnore: true */ WEBLLM_CDN_URL).catch((err) => {
      webllmPromise = null; // allow a retry after a network failure
      const e = new Error(`Could not download the in-browser AI library (${err && err.message ? err.message : err}). Check your connection and try again.`);
      e.isLocalEndpointError = true;
      throw e;
    });
  }
  return webllmPromise;
}

// Test hook only: lets a test supply a fake WebLLM module / Worker factory without a CDN or a GPU.
let workerFactory = () => new Worker(QWEN_WORKER_URL, { type: 'module' });
function __setQwenTestHooks({ webllm, createWorker } = {}) {
  webllmOverride = webllm || null;
  if (createWorker) workerFactory = createWorker;
}
function __resetQwenForTests() {
  engine = null; worker = null; loadedModelId = null; loadPromise = null; loadingModelId = null;
  queueTail = Promise.resolve(); currentController = new AbortController(); adapterInfoCache = null;
  status = { state: 'idle', progress: 0, text: '', modelId: null, presetKey: null, error: '' };
}

// ---------------------------------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------------------------------

let status = { state: 'idle', progress: 0, text: '', modelId: null, presetKey: null, error: '' };
const statusListeners = new Set();

function setStatus(patch) {
  status = { ...status, ...patch };
  for (const fn of statusListeners) { try { fn({ ...status }); } catch (e) { /* listener errors never break the engine */ } }
}
function getQwenStatus() { return { ...status }; }
function onQwenStatusChange(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }

// ---------------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------------

function makeError(message, flags = {}) {
  const e = new Error(message);
  e.isLocalEndpointError = true; // handleApiError must not treat these as hosted-API quota problems
  Object.assign(e, flags);
  return e;
}
function cancelledError() { return makeError('Cancelled.', { isCancelled: true }); }

function looksLikeContextOverflow(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return /context window|context length|prompt tokens|exceed|too long|max.?tokens/.test(msg) && /token|context/.test(msg);
}

// Rejects as soon as `signal` aborts, while the underlying promise keeps running (the queue still waits for it).
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { promise.catch(() => {}); return Promise.reject(cancelledError()); }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Engine lifecycle
// ---------------------------------------------------------------------------------------------------------------------

let engine = null;
let worker = null;
let loadedModelId = null;
let loadingModelId = null;
let loadPromise = null;
let currentController = new AbortController();

function percentText(progress) { return `${Math.max(0, Math.min(100, Math.round((progress || 0) * 100)))}%`; }

function terminateWorker() {
  try { if (worker && worker.terminate) worker.terminate(); } catch (e) { /* ignore */ }
  worker = null; engine = null; loadedModelId = null;
}

// Loads (or switches to) the preset's model. Safe to call repeatedly: an already-loaded model returns immediately,
// concurrent calls for the same model share one load. Cancelling rejects the caller promptly; the browser download itself
// cannot be aborted, so it finishes in the background and the next load of that model is instant (served from cache).
async function loadQwenModel(presetKey = getSelectedQwenPresetKey(), onProgress, { signal } = {}) {
  const caps = await detectQwenCapabilities();
  if (!caps.webgpu) throw makeError(caps.reason);
  const preset = QWEN_PRESETS[presetKey] || QWEN_PRESETS.medium;
  const modelId = await getQwenModelIdForSelection(preset.key);

  if (engine && loadedModelId === modelId) {
    if (status.state !== 'generating') setStatus({ state: 'ready', progress: 1, modelId, presetKey: preset.key, error: '' });
    return;
  }
  if (loadPromise && loadingModelId === modelId) return raceAbort(loadPromise, signal || currentController.signal);

  const report = (progress, text) => {
    setStatus({ state: 'loading', progress, text: text || '', modelId, presetKey: preset.key });
    setParseStatus(`Loading ${preset.params} Qwen model… ${percentText(progress)}${text ? ` — ${String(text).slice(0, 90)}` : ''}`, 'info');
    if (onProgress) { try { onProgress({ progress, text }); } catch (e) { /* ignore */ } }
  };

  loadingModelId = modelId;
  report(0, 'Starting…');
  const myLoad = (async () => {
    const webllm = await loadWebLlmModule();
    terminateWorker();
    worker = workerFactory();
    const eng = await webllm.CreateWebWorkerMLCEngine(worker, modelId, {
      initProgressCallback: (p) => report(p && typeof p.progress === 'number' ? p.progress : 0, p && p.text),
    });
    engine = eng;
    loadedModelId = modelId;
    setStatus({ state: 'ready', progress: 1, text: 'Ready', modelId, presetKey: preset.key, error: '' });
    setParseStatus(`Qwen ${preset.params} is ready. It runs fully in this browser — no API key, nothing is uploaded.`, 'success');
  })();
  loadPromise = myLoad;
  myLoad.then(
    () => { if (loadPromise === myLoad) { loadPromise = null; loadingModelId = null; } },
    (err) => {
      if (loadPromise === myLoad) { loadPromise = null; loadingModelId = null; }
      terminateWorker();
      setStatus({ state: 'error', error: (err && err.message) || String(err), progress: 0 });
    },
  );

  try {
    await raceAbort(myLoad, signal || currentController.signal);
  } catch (err) {
    if (err && err.isCancelled) {
      setStatus({ state: 'idle', progress: 0, text: 'Cancelled — the download continues in the background and is reused next time.' });
      setParseStatus('Model load cancelled. Any data already downloaded is kept for next time.', 'info');
      throw err;
    }
    const msg = (err && err.message) || String(err);
    const friendly = /out of memory|OOM|device lost|allocation|memory/i.test(msg)
      ? `${msg} — try a smaller Qwen model.`
      : msg;
    setParseStatus(`Could not load the model: ${friendly}`, 'error');
    throw err && err.isLocalEndpointError ? err : makeError(`Could not load the in-browser model: ${friendly}`);
  }
}

async function unloadQwenModel() {
  cancelQwen();
  const eng = engine;
  try { if (eng && eng.unload) await eng.unload(); } catch (e) { /* ignore */ }
  terminateWorker();
  loadPromise = null; loadingModelId = null;
  setStatus({ state: 'idle', progress: 0, text: '', modelId: null, error: '' });
}

// Aborts the current load wait and/or generation. Returns quickly; the current request's caller is rejected with isCancelled.
function cancelQwen() {
  const ctl = currentController;
  currentController = new AbortController(); // new requests after a cancel are not pre-aborted
  try { ctl.abort(); } catch (e) { /* ignore */ }
  try { if (engine && engine.interruptGenerate) engine.interruptGenerate(); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------------------------------------------------
// Generation (serialized)
// ---------------------------------------------------------------------------------------------------------------------

let queueTail = Promise.resolve();

// Runs `task` after every earlier task has settled. The caller's promise rejects promptly on abort; the queue itself waits
// for the real task to finish so two generations never overlap on the engine.
function enqueue(task, signal) {
  const run = queueTail.then(() => (signal && signal.aborted ? Promise.reject(cancelledError()) : task()));
  queueTail = run.catch(() => {});
  return raceAbort(run, signal);
}

function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*<think>[\s\S]*$/i, '').trim();
}

async function qwenGenerate(systemPrompt, userPrompt, { json = false, maxTokens = 1024, temperature = 0.3, signal } = {}) {
  const callerSignal = signal || null;
  const ctlSignal = currentController.signal;
  // Combine the caller's signal and the global cancel signal.
  const combined = new AbortController();
  const forward = () => combined.abort();
  if (callerSignal) { if (callerSignal.aborted) forward(); else callerSignal.addEventListener('abort', forward, { once: true }); }
  if (ctlSignal.aborted) forward(); else ctlSignal.addEventListener('abort', forward, { once: true });
  const sig = combined.signal;

  const task = async () => {
    if (sig.aborted) throw cancelledError();
    await loadQwenModel(getSelectedQwenPresetKey(), undefined, { signal: sig });
    if (sig.aborted) throw cancelledError();
    const eng = engine;
    if (!eng) throw makeError('The in-browser model is not loaded.');
    setStatus({ state: 'generating' });
    try {
      const req = {
        messages: [
          { role: 'system', content: String(systemPrompt || '') },
          { role: 'user', content: String(userPrompt || '') },
        ],
        temperature,
        max_tokens: maxTokens,
        stream: false,
      };
      if (json) req.response_format = { type: 'json_object' };
      let resp;
      try {
        resp = await eng.chat.completions.create(req);
      } catch (err) {
        if (sig.aborted) throw cancelledError();
        if (json && /response_format|json_object|grammar/i.test(String((err && err.message) || ''))) {
          // JSON mode unsupported/failed to compile: retry once without it (the caller still validates + retries on parse failure).
          delete req.response_format;
          resp = await eng.chat.completions.create(req);
        } else {
          throw err;
        }
      }
      if (sig.aborted) throw cancelledError();
      const choice = resp && resp.choices && resp.choices[0];
      return stripThinking(choice && choice.message && choice.message.content);
    } catch (err) {
      if (err && err.isCancelled) throw err;
      if (looksLikeContextOverflow(err)) {
        throw makeError(`The text is too long for the in-browser model's context window (${(err && err.message) || err}).`, { isContextOverflow: true });
      }
      throw err && err.isLocalEndpointError ? err : makeError(`In-browser model error: ${(err && err.message) || err}`);
    } finally {
      if (status.state === 'generating') setStatus({ state: engine ? 'ready' : 'idle' });
    }
  };

  try {
    return await enqueue(task, sig);
  } finally {
    if (callerSignal) callerSignal.removeEventListener('abort', forward);
    ctlSignal.removeEventListener('abort', forward);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Context-window chunking helpers (conservative: Qwen tokenization of mixed prose/numbers/CJK is roughly 2.5–3.5 chars/token)
// ---------------------------------------------------------------------------------------------------------------------

const CHARS_PER_TOKEN = 2.8;
const OUTPUT_RESERVE_TOKENS = 1100;
const OVERHEAD_TOKENS = 250;     // chat-template tokens + term-registry/instructions slack
const MIN_PAGE_BUDGET_CHARS = 700;
const PAGE_COST_OVERHEAD_CHARS = 60; // "Page N:" framing per page

function getQwenContextWindow() {
  const preset = QWEN_PRESETS[getSelectedQwenPresetKey()] || QWEN_PRESETS.medium;
  return preset.contextWindow || 4096;
}

// How many characters of page text fit in one request alongside the system prompt, the reserved output and overhead.
function computePageBudgetChars(systemPrompt, contextTokens = getQwenContextWindow(), extraChars = 0) {
  const usedChars = String(systemPrompt || '').length + extraChars;
  const availTokens = contextTokens - OUTPUT_RESERVE_TOKENS - OVERHEAD_TOKENS - Math.ceil(usedChars / CHARS_PER_TOKEN);
  return Math.max(MIN_PAGE_BUDGET_CHARS, Math.floor(availTokens * CHARS_PER_TOKEN));
}

// Splits `pages` (array of objects with a text field) into consecutive windows whose total cost fits `budgetChars`.
// A single page larger than the budget is clipped (never dropped) so every page is still covered.
// `getText`/`setText` default to `.text`.
function planPageChunks(pages, budgetChars, { getText = (p) => p.text, setText = (p, t) => ({ ...p, text: t }) } = {}) {
  const chunks = [];
  let cur = []; let curCost = 0;
  for (const page of pages || []) {
    let text = String(getText(page) || '');
    let item = page;
    const maxText = Math.max(200, budgetChars - PAGE_COST_OVERHEAD_CHARS);
    if (text.length > maxText) { text = text.slice(0, maxText); item = setText(page, text); }
    const cost = text.length + PAGE_COST_OVERHEAD_CHARS;
    if (cur.length && curCost + cost > budgetChars) { chunks.push(cur); cur = []; curCost = 0; }
    cur.push(item); curCost += cost;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ---------------------------------------------------------------------------------------------------------------------
// Batch 9 — model cache management (WebLLM 0.2.85 helpers; weights live in the Cache API under "webllm/model", "webllm/config",
// "webllm/wasm" — the library's default cacheBackend is "cache"). The service worker never intercepts these.
// ---------------------------------------------------------------------------------------------------------------------

// true / false, or null when the runtime could not be loaded (for example offline before it was ever cached).
async function hasQwenModelCached(presetKey = getSelectedQwenPresetKey()) {
  try {
    const webllm = await loadWebLlmModule();
    if (typeof webllm.hasModelInCache !== 'function') return null;
    const modelId = await getQwenModelIdForSelection(presetKey);
    return !!(await webllm.hasModelInCache(modelId));
  } catch (e) {
    return null;
  }
}

// Deletes the preset's cached weights, config and compiled library (both the f16 and f32 builds, whichever exists).
// Unloads the engine first when it is using one of them. Resolves { deleted } = number of builds removed.
async function deleteQwenModelCache(presetKey = getSelectedQwenPresetKey()) {
  const preset = QWEN_PRESETS[presetKey] || QWEN_PRESETS.medium;
  const webllm = await loadWebLlmModule();
  if (typeof webllm.deleteModelAllInfoInCache !== 'function' || typeof webllm.hasModelInCache !== 'function') {
    throw makeError('This version of the in-browser AI library cannot delete saved models.');
  }
  const ids = [preset.idF16, preset.idF32];
  if ((loadedModelId && ids.includes(loadedModelId)) || (loadingModelId && ids.includes(loadingModelId))) await unloadQwenModel();
  let deleted = 0;
  let lastError = null;
  for (const id of ids) {
    try {
      if (await webllm.hasModelInCache(id)) { await webllm.deleteModelAllInfoInCache(id); deleted++; }
    } catch (e) { lastError = e; }
  }
  if (!deleted && lastError) throw makeError(`Could not delete the saved model: ${(lastError && lastError.message) || lastError}`);
  return { deleted };
}

// { usage, quota } in bytes, or null when the browser has no estimate API.
async function getStorageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    }
  } catch (err) { /* ignore */ }
  return null;
}

// true / false, or null when unsupported.
async function isStoragePersisted() {
  try { if (navigator.storage && navigator.storage.persisted) return !!(await navigator.storage.persisted()); } catch (e) { /* ignore */ }
  return null;
}

// true (granted) / false (declined), or null when unsupported. Browsers may decline silently.
async function requestPersistentStorage() {
  try { if (navigator.storage && navigator.storage.persist) return !!(await navigator.storage.persist()); } catch (e) { /* ignore */ }
  return null;
}

// Cheap pre-download checks. WebLLM does not publish download sizes, so free-space is compared against the preset's published GPU-memory
// figure as a conservative upper bound. Returns { warn, reasons[], suggestSmaller }.
async function assessQwenDownloadRisk(presetKey = getSelectedQwenPresetKey()) {
  const preset = QWEN_PRESETS[presetKey] || QWEN_PRESETS.medium;
  const reasons = [];
  let suggestSmaller = false;
  try {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c) {
      if (c.saveData) reasons.push('Data Saver is on for this connection.');
      if (c.type === 'cellular') reasons.push('You appear to be on a mobile network (data charges may apply).');
      if (/(^|-)2g$/.test(c.effectiveType || '')) reasons.push('The connection looks very slow.');
    }
    if (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4 && preset.key !== 'small') {
      reasons.push(`This device reports about ${navigator.deviceMemory} GB of memory; the ${QWEN_PRESETS.small.params} model is safer.`);
      suggestSmaller = true;
    }
    const est = await getStorageEstimate();
    if (est && est.quota && est.quota - est.usage < preset.vramMB * 1024 * 1024) {
      reasons.push(`Free storage looks tight (about ${Math.round((est.quota - est.usage) / (1024 * 1024))} MB available to this site).`);
    }
  } catch (e) { /* warnings are best-effort */ }
  return { warn: reasons.length > 0, reasons, suggestSmaller };
}

export {
  WEBLLM_VERSION,
  WEBLLM_CDN_URL,
  QWEN_PRESETS,
  PRESET_ORDER,
  formatPresetLabel,
  isLikelyMobileDevice,
  getSelectedQwenPresetKey,
  setSelectedQwenPresetKey,
  qwenLayoutFormattingEnabled,
  setQwenLayoutFormattingEnabled,
  detectQwenCapabilities,
  getQwenModelIdForSelection,
  loadQwenModel,
  qwenGenerate,
  unloadQwenModel,
  cancelQwen,
  getQwenStatus,
  onQwenStatusChange,
  getQwenContextWindow,
  computePageBudgetChars,
  planPageChunks,
  hasQwenModelCached,
  deleteQwenModelCache,
  getStorageEstimate,
  isStoragePersisted,
  requestPersistentStorage,
  assessQwenDownloadRisk,
  __setQwenTestHooks,
  __resetQwenForTests,
};
