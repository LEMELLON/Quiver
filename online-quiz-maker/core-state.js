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
//
// UPDATE 2A (new feature work, not extraction — see
// UI_UPGRADES_HANDOFF_PROMPT.md): `state.docType` / `state.pages` /
// `state.pdfDoc` / `state.pptxFile` / `state.pptxZip` used to be plain
// fields describing a single imported document. The app now supports
// multiple imported documents at once, held in the new
// `state.sources[]` array (`{ id, name, docType, pages, pdfDoc,
// pptxFile, pptxZip }`) plus `state.activeSourceId`. Rather than hunt
// down and rewrite every read/write site of those five fields across
// doc-extraction.js, highlighting.js, editor-render.js, snippet-
// question-generation.js, etc. (which would blow this update's scope
// well past what fits in one session — see the handoff doc's split
// rationale), those five field names are turned into
// `Object.defineProperty` accessor pairs below (see SHIMMED_SOURCE_KEYS)
// that transparently proxy to "whichever source is active": a `get`
// reads off `state.sources.find(s => s.id === state.activeSourceId)`,
// a `set` writes onto it (creating a first source on first write, if
// none is active yet, so a bare `state.pages = pages` from a file that
// knows nothing about state.sources still works). This is the same
// category of ES-mechanics shim as the getter/setter pairs above, just
// applied to object properties instead of module-level `let`s — every
// existing call site that does `state.pages = pages` or reads
// `state.pdfDoc` keeps compiling and behaving correctly with ZERO
// changes to that file, because from that file's point of view
// `state.pages` is still just a plain property on `state`. Only
// main.js (multi-file import), doc-pane-navigation.js (cross-source
// Pane 3 rollover), and question-model.js / ai-api-calls.js / snippet-
// question-generation.js (small additive `sourceId` tags — see their
// own NOTEs) are touched this session; every other consumer of these
// five fields is intentionally left alone, to be revisited in Update 2B
// once there's a real multi-source UI to test against.

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
  currentPage: 1,
  // UPDATE 2A (new — see NOTE above): every imported document now lives
  // as its own entry in `sources`, shaped
  // `{ id, name, docType, pages, pdfDoc, pptxFile, pptxZip }`.
  // `activeSourceId` points at whichever one Pane 2/3 currently show —
  // `docType`/`pages`/`pdfDoc`/`pptxFile`/`pptxZip` below are NOT plain
  // fields anymore; they're accessor properties defined further down
  // this file that proxy through to the active source (see
  // SHIMMED_SOURCE_KEYS and the NOTE above).
  sources: [],
  activeSourceId: null,
};

// ---------------------------------------------------------------------
// UPDATE 2A — multi-source shim (new, not from source; see NOTE above)
// ---------------------------------------------------------------------
let sourceIdCounter = 0;

// Blank shape for a newly-created source. `docType`/`pages`/`pdfDoc`/
// `pptxFile`/`pptxZip` mirror exactly what state's own fields used to
// default to, so a freshly-created source behaves identically to a
// freshly-loaded page before any file was ever imported.
function makeBlankSource(name) {
  sourceIdCounter += 1;
  return {
    id: 'src_' + sourceIdCounter,
    name: name || '',
    docType: null,
    pages: [],
    pdfDoc: null,
    pptxFile: null,
    pptxZip: null,
  };
}

function getActiveSource() {
  return state.sources.find(s => s.id === state.activeSourceId) || null;
}

// SLIDE_PANEL_MIRROR_REVERT_AND_THUMBNAIL_FIX_PROMPT.md verification
// note: NO changes made to this file. The #sourcePane live mirror
// (slide-panel-mirror.js) this comment used to describe has been
// deleted — see that prompt. The reasoning below still applies,
// unchanged, to its actual remaining callers: main.js's
// generatePdfThumbnail()/generatePptxThumbnail() (per-card, once-per-
// source thumbnails) read a specific source object's own pdfDoc/pptxZip/
// pptxFile directly — via a captured `source` reference, not through
// this function a second time mid-async — while pptx-render.js's new
// renderPptxTier1Thumbnail() takes `file` as a plain parameter and
// doesn't touch state or getActiveSource() at all. state.sources[]'s
// shape, SHIMMED_SOURCE_KEYS, and openSource()'s click-to-open logic
// are all untouched.

// Creates a brand-new source, appends it to state.sources, and makes it
// the active one — used by main.js's file-input handler so each newly
// imported file gets its own entry (see UPDATE 2A note there). Exposed
// separately from the shim's own lazy auto-create (below) because the
// import flow needs an explicit NEW source per file, not "reuse
// whatever's already active."
function createSource(name) {
  const source = makeBlankSource(name);
  state.sources.push(source);
  state.activeSourceId = source.id;
  return source;
}

// Lazy fallback used only by the shimmed setters below: if something
// writes e.g. `state.pages = pages` while no source is active yet (the
// original single-document call pattern, still used verbatim by
// doc-extraction.js), a first source is created transparently rather
// than the write silently going nowhere. main.js's own import flow
// calls createSource() explicitly and so never relies on this path in
// practice, but it's what keeps every OTHER file's untouched
// `state.pages = ...` / `state.pdfDoc = ...` assignments working per
// the compatibility-shim design (see NOTE at top of file).
function ensureActiveSource() {
  const existing = getActiveSource();
  if (existing) return existing;
  return createSource('');
}

// The five fields every pre-2A consumer file still reads/writes as
// plain `state.<key>` properties. Defined as accessor pairs so those
// files don't need to change at all — see NOTE at top of file.
const SHIMMED_SOURCE_KEYS = ['docType', 'pages', 'pdfDoc', 'pptxFile', 'pptxZip'];
SHIMMED_SOURCE_KEYS.forEach((key) => {
  Object.defineProperty(state, key, {
    enumerable: true,
    configurable: true,
    get() {
      const source = getActiveSource();
      if (!source) return key === 'pages' ? [] : null;
      return source[key];
    },
    set(value) {
      ensureActiveSource()[key] = value;
    },
  });
});

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
  // UPDATE 2A — multi-source shim
  getActiveSource,
  createSource,
  API_KEY_STORAGE,
  MODEL_STORAGE,
  configDefaults,
  configApiKey,
  configModel,
};
