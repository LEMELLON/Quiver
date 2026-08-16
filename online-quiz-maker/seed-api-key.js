// seed-api-key.js
// Extracted verbatim from online-quiz-maker.html, source lines 732-747 —
// the try/catch block that seeds apiKeyInput.value / modelSelect.value
// from localStorage (falling back to config.js's AI_CONFIG) on page
// load. Flagged in core-state.js and ai-credentials-and-models.js as not
// assigned to any module by MODULARIZATION_SCHEMA.txt. Logic is
// UNCHANGED from source — only the import/export wrapper and the NOTE
// below were added.
//
// NOTE (structural, not a logic change): in the original single-scope
// script this block runs, in file order, AFTER the DOM refs/constants
// are declared but BEFORE refreshModelOptions/detectModels are even
// defined — and well before ai-credentials-and-models.js's own bottom-of-
// module "seed the classifier's stored key and run an initial live
// detection pass" block (source lines 809-813), which reads
// apiKeyInput.value.trim() and depends on this block having already run.
// ES `import` statements are hoisted and all execute, in the order
// written, before any of an importing module's own top-level code — so
// simply writing this logic inline in main.js AFTER
// `import './ai-credentials-and-models.js'` would run it too late (that
// module's own top-level detectModels() check would already have fired
// against an unseeded, empty apiKeyInput.value). Extracting this block
// into its own tiny module lets main.js control the ordering correctly
// with two ordinary import statements
// (`import './seed-api-key.js'` before `import './ai-credentials-and-models.js'`),
// which reproduces the original file's execution order exactly. This is
// the same category of mechanical, ES-module-driven restructuring
// already used elsewhere in this extraction (e.g. the duplicateMap /
// pendingSelection getter-setter pairs in core-state.js) — no behavior
// was changed, only how the ordering is expressed.

import { API_KEY_STORAGE, MODEL_STORAGE, configApiKey, configModel } from './core-state.js';
import { apiKeyInput, modelSelect } from './dom-refs.js';

// ---------------------------------------------------------------------
// Verbatim from source, lines 732-747
// ---------------------------------------------------------------------
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
