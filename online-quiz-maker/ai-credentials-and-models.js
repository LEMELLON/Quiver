// ai-credentials-and-models.js
// Extracted verbatim from online-quiz-maker.html (original lines 749-803,
// 795-807 event wiring, and the init block at 4930-4936-ish "Seed the
// classifier's stored key..." comment block just below toggleApiKeyBtn wiring).
// Function bodies are UNCHANGED from source — only import/export wrapper
// lines were added.

// --- Shared dependencies this module needs (defined in core-state.js /
//     dom-refs.js — do NOT redefine here, only wire up the imports once
//     those modules exist) ---
// DOM refs used below: apiKeyInput, toggleApiKeyBtn, modelSelect,
//   detectModelsBtn, modelDetectStatus
// Constants used below: MODEL_STORAGE, API_KEY_STORAGE, configModel
// Globals used below: GeminiClassifier (from gemini-classifier.js, already
//   loaded as a separate <script> — no import needed, it attaches to window)

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

// ---------------------------------------------------------------------
// Verbatim from source, lines 749-765
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Verbatim from source, lines 768-793
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Verbatim from source, lines 795-807 (event wiring that belongs to
// this module's functions — moved here per the "move with handler"
// strategy noted in the schema. NOT altered.)
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Verbatim from source, lines 809-813
// Seed the classifier's stored key and run an initial live detection pass
// if a key was already available from config.js or localStorage.
// ---------------------------------------------------------------------
if (typeof GeminiClassifier !== 'undefined' && apiKeyInput.value.trim()) {
  GeminiClassifier.setKey(apiKeyInput.value.trim());
  detectModels();
}

export { refreshModelOptions, detectModels };
