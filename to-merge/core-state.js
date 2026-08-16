// core-state.js
// Shared-context module per MODULARIZATION_SCHEMA.txt's "SHARED CONTEXT"
// section — the constants and state object/vars that every other module
// imports instead of redefining. Extracted verbatim from
// online-quiz-maker.html, source lines 632-648 (PBKDF2_ITERATIONS through
// lastDocSelection) and lines 723-730 (API_KEY_STORAGE through
// configModel). Values/initializers are UNCHANGED from source — only
// import/export wrapper lines, and the getter/setter pairs described in
// the NOTE below, were added.
//
// FLAGGED (not moved here, not part of this module): source lines
// 732-747, the try/catch block that seeds apiKeyInput.value /
// modelSelect.value from localStorage/config.js on page load. It reads
// API_KEY_STORAGE/MODEL_STORAGE/configApiKey/configModel (declared here)
// but also directly mutates apiKeyInput and modelSelect (DOM refs), so
// it isn't a state *declaration* — it's page-load init logic, same
// category as the "renderTextVersion(); addQuestion();" init block the
// schema already reserves for the main orchestrator. Left for that pass
// rather than guessed into this module (per the schema's own "if
// something is ambiguous, leave it in place / flag it" instruction).
//
// NOTE (structural, not a logic change): `duplicateMap` (source line
// 2051, originally `let duplicateMap = new Map();`) and
// `pendingSelection` / `lastDocSelection` (source lines 647-648) are
// reassigned from MORE THAN ONE module in the split-up source (see the
// matching NOTEs in question-model.js, editor-render.js, and
// selection-toolbar.js). Plain ES `import` bindings are read-only, so a
// module that only imports one of these can't do `x = ...` the way the
// original single-scope code did. Each therefore gets a getter/setter
// pair here instead of a bare exported `let` — the values and their
// initial states (`new Map()`, `null`, `null`) are byte-for-byte what
// the source used, only the read/write mechanism changed to satisfy ES
// module semantics.

// ---------------------------------------------------------------------
// Verbatim from source, lines 632-634
// ---------------------------------------------------------------------
const PBKDF2_ITERATIONS = 150000;
const SALT_LEN = 16;
const IV_LEN = 12;

// ---------- State ----------
// ---------------------------------------------------------------------
// Verbatim from source, lines 637-645
// ---------------------------------------------------------------------
const state = {
  questions: [],
  idCounter: 0,
  activeCardId: null,
  docType: null,       // 'pdf' | 'pptx' | null
  pages: [],             // [{ pageNumber, text }]
  pdfDoc: null,           // pdf.js document proxy (docType === 'pdf' only)
  currentPage: 1,
  // GEMINI_FIX_REDO_AND_PPTX_STATE_BUG_PROMPT.md Part B — set by
  // extractPptxPages() in doc-extraction.js (docType === 'pptx' only),
  // consumed by pptx-render.js's Tier 1 (pptxFile) and Tier 2 (pptxZip).
  // Declared here explicitly (rather than only ever appearing as a
  // dynamic assignment) so their absence is visible in this object's
  // shape instead of silently being `undefined` with no trace.
  pptxFile: null,
  pptxZip: null,
};

// source line 647-648 (see NOTE at top of file) — reassigned from more
// than one module, so exposed via getter/setter instead of a bare `let`.
let pendingSelection = null; // { text, sourcePage, range } — drives the floating "Generate Question from Selection" toolbar; cleared on any click away from it.
let lastDocSelection = null; // { text, sourcePage, range } — same shape, but persists across clicks elsewhere in the UI (e.g. onto the editor panel), so the per-field "🔎 Scan question" / "🔎 Scan answer" buttons can still read the highlight the user just made in Pane 2. Only replaced by a fresh valid selection.
function getPendingSelection() { return pendingSelection; }
function setPendingSelection(value) { pendingSelection = value; }
function getLastDocSelection() { return lastDocSelection; }
function setLastDocSelection(value) { lastDocSelection = value; }

// source line 2051 (see NOTE at top of file) — reassigned from both
// question-model.js (removeFlaggedDuplicates) and editor-render.js
// (renderQuestionNav / renderPane3QuestionNav), so exposed via
// getter/setter instead of a bare `let`.
let duplicateMap = new Map(); // qid -> { matchId, matchIndex, reason }
function getDuplicateMap() { return duplicateMap; }
function setDuplicateMap(value) { duplicateMap = value; }

// =====================================================================
// AI credentials: config.js defaults, overridden by localStorage,
// abstracted through GeminiClassifier (gemini-classifier.js)
// =====================================================================
// ---------------------------------------------------------------------
// Verbatim from source, lines 723-724
// ---------------------------------------------------------------------
const API_KEY_STORAGE = 'quizMaker.apiKey';
const MODEL_STORAGE = 'quizMaker.model';

// ---------------------------------------------------------------------
// Verbatim from source, lines 726-730
// ---------------------------------------------------------------------
const configDefaults = (typeof AI_CONFIG === 'object' && AI_CONFIG) ? AI_CONFIG : {};
const configApiKey = (configDefaults.apiKey && configDefaults.apiKey !== 'YOUR_API_KEY_HERE')
  ? configDefaults.apiKey
  : '';
const configModel = configDefaults.model || '';

export {
  PBKDF2_ITERATIONS,
  SALT_LEN,
  IV_LEN,
  state,
  getPendingSelection,
  setPendingSelection,
  getLastDocSelection,
  setLastDocSelection,
  getDuplicateMap,
  setDuplicateMap,
  API_KEY_STORAGE,
  MODEL_STORAGE,
  configDefaults,
  configApiKey,
  configModel,
};
