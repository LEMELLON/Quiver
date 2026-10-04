// qwen-worker.js
// Batch 8 — Web Worker that hosts the WebLLM engine so model loading and token generation never block the UI thread.
// Loaded by qwen-local.js via `new Worker(new URL('./qwen-worker.js', import.meta.url), { type: 'module' })`.
// The WebLLM version MUST match WEBLLM_VERSION in qwen-local.js (both are pinned to the same jsDelivr URL).
import { WebWorkerMLCEngineHandler } from 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => {
  handler.onmessage(msg);
};
