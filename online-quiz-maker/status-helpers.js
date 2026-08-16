// status-helpers.js
// Extracted verbatim from online-quiz-maker.html, source lines 816-827.
// Function bodies are UNCHANGED from source — only import/export wrapper
// lines were added.
//
// Called from ~31 places across nearly every other module (question-model,
// doc-extraction, layout-formatting, selection-toolbar, variant-generation,
// snippet-question-generation, ai-api-calls, batch-scan, etc.) — every
// module that needs one just imports it from here, no other changes.

import { parseStatus, selectionGenStatus } from './dom-refs.js';

// ---------------------------------------------------------------------
// Verbatim from source, lines 816-820
// ---------------------------------------------------------------------
function setParseStatus(msg, tone) {
  if (!msg) { parseStatus.classList.add('hidden'); parseStatus.textContent = ''; return; }
  parseStatus.textContent = msg;
  parseStatus.className = 'mt-3 text-xs font-mono ' + (tone === 'error' ? 'text-danger' : tone === 'success' ? 'text-amber' : 'text-mute');
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 822-827
// ---------------------------------------------------------------------
function setSelectionGenStatus(msg, tone) {
  if (!msg) { selectionGenStatus.classList.add('hidden'); selectionGenStatus.textContent = ''; return; }
  selectionGenStatus.textContent = msg;
  selectionGenStatus.className = 'shrink-0 border-t border-edge px-4 py-2 text-xs font-mono ' +
    (tone === 'error' ? 'text-danger' : tone === 'success' ? 'text-amber' : 'text-mute');
}

export { setParseStatus, setSelectionGenStatus };
