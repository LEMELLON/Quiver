import {
  apiKeyInput,
  toggleApiKeyBtn,
  modelSelect,
  detectModelsBtn,
  modelDetectStatus,
  providerSelect,
  apiKeyRow,
  modelSelectRow,
  endpointRow,
  endpointUrlInput,
  endpointModelInput,
  endpointModelList,
  detectEndpointModelsBtn,
  providerHelp,
} from './dom-refs.js';

import {
  MODEL_STORAGE,
  API_KEY_STORAGE,
  PROVIDER_STORAGE,
  ENDPOINT_URL_STORAGE,
  QWEN_MODEL_STORAGE,
  configModel,
} from './core-state.js';

import { getActiveProvider } from './ai-provider.js';
import { normalizeOpenAiBaseUrl } from './ai-api-calls.js';

// Help text shown under the provider controls; one entry per provider option value.
const PROVIDER_HELP = {
  default: 'Defaults from config.js; overrides you type here are saved to this browser\'s local storage. Sent directly to the selected provider\'s API — never to us.',
  'openai-compatible': 'Works with any server that speaks the OpenAI chat API (Ollama, LM Studio, llama.cpp server, or a hosted Qwen). The key is optional. The server must allow this page\'s origin (CORS): for Ollama set OLLAMA_ORIGINS, for LM Studio enable "Enable CORS". Requests go straight from this browser to the URL you enter.',
  'qwen-browser': 'In-browser Qwen is coming in a later update. Until then, pick another provider — or use "OpenAI-compatible endpoint" with a local Qwen server.',
};

// Shows/hides the key row, Model dropdown and endpoint inputs for the chosen provider, and refreshes the help text.
// Keyed off the select's own value (not the resolved provider), so 'auto' shows the same controls as today.
function applyProviderUi() {
  const chosen = providerSelect.value;
  const isEndpoint = chosen === 'openai-compatible';
  const isQwenBrowser = chosen === 'qwen-browser';

  apiKeyRow.classList.toggle('hidden', isQwenBrowser);                // no key needed for in-browser Qwen
  modelSelectRow.classList.toggle('hidden', isEndpoint || isQwenBrowser); // endpoint uses a free-text model name; Batch 8 re-shows this row with Qwen presets
  endpointRow.classList.toggle('hidden', !isEndpoint);

  apiKeyInput.placeholder = isEndpoint
    ? 'Optional — most local servers ignore it'
    : 'AIza… (Gemini) or sk-… (OpenAI)';
  providerHelp.textContent = PROVIDER_HELP[chosen] || PROVIDER_HELP.default;

  if (isQwenBrowser) modelDetectStatus.classList.add('hidden');
}

// Repopulates the model dropdown and restores the previously selected model if still valid.
function refreshModelOptions(models) {
  if (!Array.isArray(models) || models.length === 0) return;
  const previous = modelSelect.value;
  modelSelect.innerHTML = '';
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    modelSelect.appendChild(opt);
  });

  let storedModel = '';
  try { storedModel = localStorage.getItem(MODEL_STORAGE) || ''; } catch (e) { /* ignore */ }
  const preferred = [previous, storedModel, configModel].find(
    v => v && [...modelSelect.options].some(o => o.value === v)
  );
  if (preferred) modelSelect.value = preferred;
}

// Lists the models an OpenAI-compatible endpoint serves (GET {base}/models) into the model-name suggestions; never touches the Model dropdown.
async function detectEndpointModels() {
  const url = (endpointUrlInput.value || '').trim();
  if (!url) {
    modelDetectStatus.classList.add('hidden');
    return;
  }
  const base = normalizeOpenAiBaseUrl(url);
  modelDetectStatus.textContent = 'Asking the endpoint which models it serves…';
  modelDetectStatus.classList.remove('hidden');

  try {
    const headers = {};
    const key = apiKeyInput.value.trim();
    if (key) headers['Authorization'] = `Bearer ${key}`;
    const res = await fetch(`${base}/models`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ids = (Array.isArray(data && data.data) ? data.data : [])
      .map(m => m && m.id).filter(id => typeof id === 'string' && id);

    endpointModelList.innerHTML = '';
    ids.forEach(id => {
      const opt = document.createElement('option');
      opt.value = id;
      endpointModelList.appendChild(opt);
    });
    modelDetectStatus.textContent = ids.length
      ? `${ids.length} model${ids.length === 1 ? '' : 's'} available at this endpoint — pick one in the Model name box.`
      : 'The endpoint answered but listed no models. Type the model name by hand.';
  } catch (err) {
    modelDetectStatus.textContent = `Couldn't list models from this endpoint (${err.message || err}). Check the URL, that the server is running, and that it allows this origin (CORS) — or just type the model name.`;
  }
}

// Detects available AI models for the entered API key (hosted providers) or endpoint (OpenAI-compatible) and updates the status text.
async function detectModels() {
  const provider = getActiveProvider();
  if (provider === 'openai-compatible') {
    await detectEndpointModels();
    return;
  }
  if (provider === 'qwen-browser') {
    modelDetectStatus.classList.add('hidden');
    return;
  }

  const key = apiKeyInput.value.trim();
  if (!key) {
    modelDetectStatus.classList.add('hidden');
    return;
  }
  if (typeof GeminiClassifier === 'undefined') {
    modelDetectStatus.textContent = 'Model classifier failed to load — check your network connection.';
    modelDetectStatus.classList.remove('hidden');
    return;
  }

  modelDetectStatus.textContent = 'Detecting available models…';
  modelDetectStatus.classList.remove('hidden');

  GeminiClassifier.setKey(key);
  const result = await GeminiClassifier.classifyKeyModels(key);
  refreshModelOptions(result.models);

  if (result.success) {
    const n = result.models.length;
    modelDetectStatus.textContent = `${n} model${n === 1 ? '' : 's'} available for this ${result.provider === 'openai' ? 'OpenAI' : 'Gemini'} key.`;
  } else {
    modelDetectStatus.textContent = `Couldn't verify this key live (${result.reason}) — showing a fallback model list.`;
  }
}

// Wires API key persistence, model detection triggers, model persistence, and key visibility toggle.
apiKeyInput.addEventListener('input', () => {
  try { localStorage.setItem(API_KEY_STORAGE, apiKeyInput.value); } catch (e) { /* ignore */ }
});
apiKeyInput.addEventListener('change', () => { detectModels(); });
detectModelsBtn.addEventListener('click', () => { detectModels(); });
modelSelect.addEventListener('change', () => {
  try { localStorage.setItem(MODEL_STORAGE, modelSelect.value); } catch (e) { /* ignore */ }
});
toggleApiKeyBtn.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  toggleApiKeyBtn.textContent = isPassword ? 'Hide' : 'Show';
});

// Batch 7: provider picker + OpenAI-compatible endpoint inputs — persist on edit, re-detect on commit.
providerSelect.addEventListener('change', () => {
  try { localStorage.setItem(PROVIDER_STORAGE, providerSelect.value); } catch (e) { /* ignore */ }
  applyProviderUi();
  modelDetectStatus.classList.add('hidden'); // stale text from the previous provider
  detectModels();
});
endpointUrlInput.addEventListener('input', () => {
  try { localStorage.setItem(ENDPOINT_URL_STORAGE, endpointUrlInput.value); } catch (e) { /* ignore */ }
});
endpointUrlInput.addEventListener('change', () => { detectModels(); });
endpointModelInput.addEventListener('input', () => {
  try { localStorage.setItem(QWEN_MODEL_STORAGE, endpointModelInput.value); } catch (e) { /* ignore */ }
});
detectEndpointModelsBtn.addEventListener('click', () => { detectModels(); });

// Seeds the classifier's stored key and runs an initial detection pass if a key is already present.
applyProviderUi();
if (typeof GeminiClassifier !== 'undefined' && apiKeyInput.value.trim()) {
  GeminiClassifier.setKey(apiKeyInput.value.trim());
  detectModels();
} else if (getActiveProvider() === 'openai-compatible' && endpointUrlInput.value.trim()) {
  detectModels();
}

export { refreshModelOptions, detectModels, applyProviderUi };
