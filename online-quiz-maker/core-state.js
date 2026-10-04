// core-state.js

// PBKDF2 iteration count and salt/IV byte lengths used for Quiz Code encryption.
const PBKDF2_ITERATIONS = 150000;
const SALT_LEN = 16;
const IV_LEN = 12;

// Central app state: questions, active card/page, and imported sources.
const state = {
  questions: [],
  idCounter: 0,
  activeCardId: null,
  currentPage: 1,
  sources: [],
  activeSourceId: null,
};

let sourceIdCounter = 0;

// Creates a blank source object shaped like a freshly-imported document.
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

// Returns the currently active source, or null if none is active.
function getActiveSource() {
  return state.sources.find(s => s.id === state.activeSourceId) || null;
}

// Creates a new source, appends it to state.sources, and makes it active.
function createSource(name) {
  const source = makeBlankSource(name);
  state.sources.push(source);
  state.activeSourceId = source.id;
  return source;
}

// Returns the active source, creating a blank one first if none exists.
function ensureActiveSource() {
  const existing = getActiveSource();
  if (existing) return existing;
  return createSource('');
}

// Proxies docType/pages/pdfDoc/pptxFile/pptxZip onto the active source, so
// plain `state.<key>` reads/writes transparently target whichever source is active.
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

let pendingSelection = null; // { text, sourcePage, range } — drives the floating selection toolbar; cleared on click-away.
let lastDocSelection = null; // { text, sourcePage, range } — persists across clicks so per-field "scan" buttons can still read it.
function getPendingSelection() { return pendingSelection; }
function setPendingSelection(value) { pendingSelection = value; }
function getLastDocSelection() { return lastDocSelection; }
function setLastDocSelection(value) { lastDocSelection = value; }

let duplicateMap = new Map(); // qid -> { matchId, matchIndex, reason }
function getDuplicateMap() { return duplicateMap; }
function setDuplicateMap(value) { duplicateMap = value; }

// AI credentials: config.js defaults, overridden by localStorage, used via GeminiClassifier.
const API_KEY_STORAGE = 'quizMaker.apiKey';
const MODEL_STORAGE = 'quizMaker.model';
// Batch 7: provider selection + OpenAI-compatible endpoint settings (see ai-provider.js).
const PROVIDER_STORAGE = 'quizMaker.provider';
const ENDPOINT_URL_STORAGE = 'quizMaker.endpointUrl';
const QWEN_MODEL_STORAGE = 'quizMaker.qwenModel'; // free-text model name for the OpenAI-compatible endpoint (Batch 8 reuses it for the in-browser preset)

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
  getActiveSource,
  createSource,
  API_KEY_STORAGE,
  MODEL_STORAGE,
  PROVIDER_STORAGE,
  ENDPOINT_URL_STORAGE,
  QWEN_MODEL_STORAGE,
  configDefaults,
  configApiKey,
  configModel,
};
