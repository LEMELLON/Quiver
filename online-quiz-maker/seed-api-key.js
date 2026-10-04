// seed-api-key.js
// Page-load init: seeds apiKeyInput/modelSelect from localStorage, falling back to config.js's AI_CONFIG.
// Batch 7: also seeds the provider picker and the OpenAI-compatible endpoint inputs from localStorage (no config.js defaults for those).

import {
  API_KEY_STORAGE,
  MODEL_STORAGE,
  PROVIDER_STORAGE,
  ENDPOINT_URL_STORAGE,
  QWEN_MODEL_STORAGE,
  configApiKey,
  configModel,
} from './core-state.js';
import {
  apiKeyInput,
  modelSelect,
  providerSelect,
  endpointUrlInput,
  endpointModelInput,
} from './dom-refs.js';

try {
  const storedKey = localStorage.getItem(API_KEY_STORAGE);
  apiKeyInput.value = storedKey || configApiKey || '';

  const storedModel = localStorage.getItem(MODEL_STORAGE);
  const preferredModel = storedModel || configModel;
  if (preferredModel && [...modelSelect.options].some(o => o.value === preferredModel)) {
    modelSelect.value = preferredModel;
  }
} catch (e) {
  // localStorage unavailable — fall back to config.js values only
  apiKeyInput.value = configApiKey || '';
  if (configModel && [...modelSelect.options].some(o => o.value === configModel)) {
    modelSelect.value = configModel;
  }
}

// Provider settings: a stored value that is no longer a valid option falls back to the select's default ('auto').
try {
  const storedProvider = localStorage.getItem(PROVIDER_STORAGE);
  if (storedProvider && [...providerSelect.options].some(o => o.value === storedProvider)) {
    providerSelect.value = storedProvider;
  }
  endpointUrlInput.value = localStorage.getItem(ENDPOINT_URL_STORAGE) || '';
  endpointModelInput.value = localStorage.getItem(QWEN_MODEL_STORAGE) || '';
} catch (e) {
  // localStorage unavailable — leave the defaults (auto / empty endpoint)
}
