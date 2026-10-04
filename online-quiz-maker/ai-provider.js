// ai-provider.js
// Batch 7 — the ONE place that decides which AI provider is active and routes a prompt to it.
//
// Before this module the provider was inferred in ~8 places by `apiKey.startsWith('sk-') ? 'openai' : 'gemini'`, and most
// paths threw "Enter your API key" before doing anything, which blocked any provider that needs no key. Everything now goes
// through getActiveProvider() / providerNeedsKey() / ensureProviderReady() / callAi().
//
// Providers:
//   'auto'              today's behaviour: key starts with "sk-" -> OpenAI, anything else -> Gemini
//   'gemini'            Gemini, explicitly
//   'openai'            OpenAI, explicitly
//   'qwen-browser'      in-browser Qwen via WebLLM/WebGPU (qwen-local.js, Batch 8); no key, nothing leaves the browser
//   'openai-compatible' any server that speaks OpenAI's /chat/completions (Ollama, LM Studio, llama.cpp server, hosted Qwen…)
//
// Import cycle with ai-api-calls.js (it imports callAi from here; this file imports the raw call functions from there) is safe:
// every cross-use is inside a function body, never at module-evaluation time (same pattern as layout-formatting.js).

import { apiKeyInput, modelSelect, providerSelect, endpointUrlInput, endpointModelInput } from './dom-refs.js';
import { callGeminiApiWithRetry, callOpenAiApi } from './ai-api-calls.js';
import { qwenGenerate, getSelectedQwenPresetKey } from './qwen-local.js';
import { safeParseAIJson } from './ai-prompt-builders.js';

const PROVIDERS = ['auto', 'gemini', 'openai', 'qwen-browser', 'openai-compatible'];

// Resolves the effective provider: 'gemini' | 'openai' | 'qwen-browser' | 'openai-compatible'.
// `auto` (and any unknown/empty stored value) keeps the legacy key-prefix inference, so existing users see no change.
function getActiveProvider() {
  const chosen = providerSelect && PROVIDERS.includes(providerSelect.value) ? providerSelect.value : 'auto';
  if (chosen !== 'auto') return chosen;
  const key = apiKeyInput.value.trim();
  return key.startsWith('sk-') ? 'openai' : 'gemini';
}

// Whether the provider cannot work without an API key. In-browser Qwen needs none; an OpenAI-compatible endpoint treats the key as optional
// (local servers ignore it, hosted ones usually want it — and when one is typed it is sent).
function providerNeedsKey(provider) {
  return provider === 'gemini' || provider === 'openai';
}

// true for providers that run on this machine / network rather than a metered hosted API (used to pick error wording and skip throttles).
function isLocalProvider(provider) {
  return provider === 'qwen-browser' || provider === 'openai-compatible';
}

// Only Gemini's free tier needs the inter-request sleeps (~15 RPM); OpenAI and the local providers don't.
function providerNeedsThrottle(provider) {
  return provider === 'gemini';
}

// The model id to send for the active provider: the free-text model name for an endpoint, otherwise the Model dropdown.
function getActiveModel(provider = getActiveProvider()) {
  if (provider === 'openai-compatible') return (endpointModelInput.value || '').trim();
  if (provider === 'qwen-browser') return getSelectedQwenPresetKey();
  return modelSelect.value;
}

function getEndpointUrl() {
  return (endpointUrlInput.value || '').trim();
}

// Throws a friendly Error if the active provider can't be used yet; otherwise returns { provider, apiKey, model }.
// `missingKeyMessage` lets each call site keep its existing wording when a key is required but absent.
function ensureProviderReady(missingKeyMessage) {
  const provider = getActiveProvider();
  const apiKey = apiKeyInput.value.trim();
  if (providerNeedsKey(provider) && !apiKey) {
    throw new Error(missingKeyMessage || 'Enter your Gemini or OpenAI API key in Pane 1 first.');
  }
  if (provider === 'openai-compatible') {
    if (!getEndpointUrl()) throw new Error('Enter the endpoint URL (for example http://localhost:11434/v1) in Pane 1 first.');
    if (!getActiveModel(provider)) throw new Error('Enter the model name your endpoint serves (for example qwen2.5:3b) in Pane 1 first.');
  }
  return { provider, apiKey, model: getActiveModel(provider) };
}

// Non-throwing form of ensureProviderReady, for "should I even try?" checks (e.g. auto-sync).
function isProviderConfigured() {
  try {
    ensureProviderReady();
    return true;
  } catch (e) {
    return false;
  }
}

// The single dispatcher. Resolves to the model's raw text response.
//   json: true  -> the caller wants a JSON object back (OpenAI-style JSON mode where supported)
//   json: false -> the caller wants raw text/HTML back (e.g. layout formatting)
// Gemini ignores `json` exactly as before (callGeminiApiWithRetry has no such switch), so Gemini/OpenAI outcomes are unchanged.
async function callAi(systemPrompt, userPrompt, { json = true, missingKeyMessage, signal } = {}) {
  const { provider, apiKey, model } = ensureProviderReady(missingKeyMessage);

  if (provider === 'gemini') {
    return await callGeminiApiWithRetry(apiKey, model, systemPrompt, userPrompt);
  }
  if (provider === 'openai') {
    return await callOpenAiApi(apiKey, model, systemPrompt, userPrompt, json);
  }
  if (provider === 'openai-compatible') {
    return await callOpenAiApi(apiKey, model, systemPrompt, userPrompt, json, { baseUrl: getEndpointUrl() });
  }
  if (provider === 'qwen-browser') {
    // Small local models: JSON mode when the engine supports it, low temperature, and ONE retry at an even lower temperature
    // if the reply does not parse. A reply that still fails is returned as-is so callers' existing graceful no-op paths apply.
    const maxTokens = json ? 1100 : 2048;
    const first = await qwenGenerate(systemPrompt, userPrompt, { json, maxTokens, temperature: 0.3, signal });
    if (!json) return first;
    try { if (safeParseAIJson(first)) return first; } catch (e) { /* retry below */ } // null or a throw both mean "did not parse"
    const second = await qwenGenerate(systemPrompt, userPrompt, { json, maxTokens, temperature: 0.1, signal });
    return second;
  }
  throw new Error(`Unknown AI provider "${provider}".`);
}

export {
  PROVIDERS,
  getActiveProvider,
  providerNeedsKey,
  isLocalProvider,
  providerNeedsThrottle,
  getActiveModel,
  getEndpointUrl,
  ensureProviderReady,
  isProviderConfigured,
  callAi,
};
