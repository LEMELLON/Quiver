import {
  apiKeyInput,
  toggleApiKeyBtn,
  modelSelect,
  detectModelsBtn,
  modelDetectStatus,
} from './dom-refs.js';

import {
  MODEL_STORAGE,
  API_KEY_STORAGE,
  configModel,
} from './core-state.js';

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

// Detects available AI models for the entered API key and updates the status text.
async function detectModels() {
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

// Seeds the classifier's stored key and runs an initial detection pass if a key is already present.
if (typeof GeminiClassifier !== 'undefined' && apiKeyInput.value.trim()) {
  GeminiClassifier.setKey(apiKeyInput.value.trim());
  detectModels();
}

export { refreshModelOptions, detectModels };
