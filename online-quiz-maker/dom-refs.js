// dom-refs.js

const pane1 = document.getElementById('pane1');
const pane2 = document.getElementById('pane2');
const pane3 = document.getElementById('pane3');

// questionNavGroup wraps questionNavEl + questionNavPager; questionNavEl still holds just the chip buttons.
const questionNavGroup = document.getElementById('questionNavGroup');
const questionNavEl = document.getElementById('questionNav');
const questionNavPager = document.getElementById('questionNavPager');
const activeEditorEl = document.getElementById('activeEditor');
const emptyState = document.getElementById('emptyState');
const questionCountEl = document.getElementById('questionCount');
const quizTitleInput = document.getElementById('quizTitle');
const addQuestionBtn = document.getElementById('addQuestionBtn');
const removeDuplicatesBtn = document.getElementById('removeDuplicatesBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const quizCodeBtn = document.getElementById('quizCodeBtn');

const pdfFileInput = document.getElementById('pdfFileInput');
const parseStatus = document.getElementById('parseStatus');
const apiKeyInput = document.getElementById('apiKeyInput');
const toggleApiKeyBtn = document.getElementById('toggleApiKeyBtn');
const modelSelect = document.getElementById('modelSelect');
const detectModelsBtn = document.getElementById('detectModelsBtn');
const modelDetectStatus = document.getElementById('modelDetectStatus');

const docTextViewport = document.getElementById('docTextViewport');
const docTextContainer = document.getElementById('docTextContainer');
const selectionToolbar = document.getElementById('selectionToolbar');
const selectionGenerateBtn = document.getElementById('selectionGenerateBtn');
const selectionQuestionType = document.getElementById('selectionQuestionType');
const selectionGenStatus = document.getElementById('selectionGenStatus');
const formatLayoutBtn = document.getElementById('formatLayoutBtn');
const recheckHighlightsBtn = document.getElementById('recheckHighlightsBtn');

const docPanelTitle = document.getElementById('docPanelTitle');
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const scanCurrentPageBtn = document.getElementById('scanCurrentPageBtn');
const scanCurrentPageType = document.getElementById('scanCurrentPageType');
const pane3QuestionNavEl = document.getElementById('pane3QuestionNav');
const pageInput = document.getElementById('pageInput');
const totalPagesEl = document.getElementById('totalPages');
const pdfCanvas = document.getElementById('pdfCanvas');
const pdfViewport = document.getElementById('pdfViewport');
const pdfEmptyState = document.getElementById('pdfEmptyState');
const slideTextPreview = document.getElementById('slideTextPreview');
const syncBadge = document.getElementById('syncBadge');
const syncBadgeText = document.getElementById('syncBadgeText');

// PPTX tier1 (real render)/tier2 (image grid) containers and loading placeholder, toggled per slide by doc-pane-navigation.js's renderPptxSlide().
const pptxTier1Container = document.getElementById('pptxTier1Container');
const pptxTier2Container = document.getElementById('pptxTier2Container');
const pptxLoadingState = document.getElementById('pptxLoadingState');

const quizCodeModal = document.getElementById('quizCodeModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const secretKeyInput = document.getElementById('secretKeyInput');
const copySecretBtn = document.getElementById('copySecretBtn');
const regenSecretBtn = document.getElementById('regenSecretBtn');
const generateCodeBtn = document.getElementById('generateCodeBtn');
const codeResultBox = document.getElementById('codeResultBox');
const quizCodeOutput = document.getElementById('quizCodeOutput');
const copyCodeBtn = document.getElementById('copyCodeBtn');
const modalError = document.getElementById('modalError');

const scanRangeBtn = document.getElementById('scanRangeBtn');
const scanRangeModal = document.getElementById('scanRangeModal');
const closeScanRangeModalBtn = document.getElementById('closeScanRangeModalBtn');
// Source picker for the Scan Pages modal; scanSourceFieldEl (wrapper) hides when 0-1 sources exist.
const scanSourceSelect = document.getElementById('scanSourceSelect');
const scanSourceFieldEl = document.getElementById('scanSourceField');
const scanFromPage = document.getElementById('scanFromPage');
const scanToPage = document.getElementById('scanToPage');
const scanQuestionType = document.getElementById('scanQuestionType');
const scanRangeHint = document.getElementById('scanRangeHint');
const scanRangeGenerateBtn = document.getElementById('scanRangeGenerateBtn');
const scanRangeStatus = document.getElementById('scanRangeStatus');
const scanRangeError = document.getElementById('scanRangeError');

const importDetailsEl = document.getElementById('importDetails');

// Wrapper around importDetails + sourceList; OS file-drop listeners target this so drops work regardless of panel/stack state.
const sourceStackAreaEl = document.getElementById('sourceStackArea');

// Draggable stack of imported sources rendered by main.js's renderSourceList(); visibility toggled on state.sources.length.
const sourceListEl = document.getElementById('sourceList');

// Term nav bar panel and the filtered-term indicator strip; see editor-render.js's renderTermBar().
const termBarEl = document.getElementById('termBar');
const termFilterIndicatorEl = document.getElementById('termFilterIndicator');

// Scope toggle (all vs. active-page-only) and live term-search input for the term panel.
const termScopeToggleEl = document.getElementById('termScopeToggle');
const termSearchInputEl = document.getElementById('termSearchInput');

export {
  pane1,
  pane2,
  pane3,
  questionNavGroup,
  questionNavEl,
  questionNavPager,
  activeEditorEl,
  emptyState,
  questionCountEl,
  quizTitleInput,
  addQuestionBtn,
  removeDuplicatesBtn,
  exportJsonBtn,
  quizCodeBtn,
  pdfFileInput,
  parseStatus,
  apiKeyInput,
  toggleApiKeyBtn,
  modelSelect,
  detectModelsBtn,
  modelDetectStatus,
  docTextViewport,
  docTextContainer,
  selectionToolbar,
  selectionGenerateBtn,
  selectionQuestionType,
  selectionGenStatus,
  formatLayoutBtn,
  recheckHighlightsBtn,
  docPanelTitle,
  prevPageBtn,
  nextPageBtn,
  scanCurrentPageBtn,
  scanCurrentPageType,
  pane3QuestionNavEl,
  pageInput,
  totalPagesEl,
  pdfCanvas,
  pdfViewport,
  pdfEmptyState,
  slideTextPreview,
  pptxTier1Container,
  pptxTier2Container,
  pptxLoadingState,
  syncBadge,
  syncBadgeText,
  quizCodeModal,
  closeModalBtn,
  secretKeyInput,
  copySecretBtn,
  regenSecretBtn,
  generateCodeBtn,
  codeResultBox,
  quizCodeOutput,
  copyCodeBtn,
  modalError,
  scanRangeBtn,
  scanRangeModal,
  closeScanRangeModalBtn,
  scanSourceSelect,
  scanSourceFieldEl,
  scanFromPage,
  scanToPage,
  scanQuestionType,
  scanRangeHint,
  scanRangeGenerateBtn,
  scanRangeStatus,
  scanRangeError,
  importDetailsEl,
  sourceStackAreaEl,
  sourceListEl,
  termBarEl,
  termFilterIndicatorEl,
  termScopeToggleEl,
  termSearchInputEl,
};
