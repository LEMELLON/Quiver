// seed-api-key.js
// Page-load init: seeds apiKeyInput/modelSelect from localStorage, falling back to config.js's AI_CONFIG.

import { API_KEY_STORAGE, MODEL_STORAGE, configApiKey, configModel } from './core-state.js';
import { apiKeyInput, modelSelect } from './dom-refs.js';

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
