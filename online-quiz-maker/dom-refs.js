// dom-refs.js

const pane1 = document.getElementById('pane1');
const pane2 = document.getElementById('pane2');
const pane3 = document.getElementById('pane3');

// Wraps #pane2/#pane3 as a single resizable grid column, its own internal fr-split (batch 5A — see main.js's setupInternalSplitDrag()).
const motherPaneEl = document.getElementById('motherPane');

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
// Batch 7: provider picker + the rows/inputs it toggles (see ai-provider.js / ai-credentials-and-models.js's applyProviderUi()).
const providerSelect = document.getElementById('providerSelect');
const apiKeyRow = document.getElementById('apiKeyRow');
const modelSelectRow = document.getElementById('modelSelectRow');
const endpointRow = document.getElementById('endpointRow');
const endpointUrlInput = document.getElementById('endpointUrlInput');
const endpointModelInput = document.getElementById('endpointModelInput');
const endpointModelList = document.getElementById('endpointModelList');
const detectEndpointModelsBtn = document.getElementById('detectEndpointModelsBtn');
const providerHelp = document.getElementById('providerHelp');
// Batch 8: in-browser Qwen controls (see qwen-ui.js / qwen-local.js).
const qwenRow = document.getElementById('qwenRow');
const qwenModelSelect = document.getElementById('qwenModelSelect');
const qwenLoadBtn = document.getElementById('qwenLoadBtn');
const qwenCancelBtn = document.getElementById('qwenCancelBtn');
const qwenUnloadBtn = document.getElementById('qwenUnloadBtn');
const qwenProgressWrap = document.getElementById('qwenProgressWrap');
const qwenProgressBar = document.getElementById('qwenProgressBar');
const qwenStatusEl = document.getElementById('qwenStatus');
const qwenLayoutToggle = document.getElementById('qwenLayoutToggle');

const docTextViewport = document.getElementById('docTextViewport');
const docTextContainer = document.getElementById('docTextContainer');
const selectionToolbar = document.getElementById('selectionToolbar');
const selectionGenerateBtn = document.getElementById('selectionGenerateBtn');
const selectionQuestionType = document.getElementById('selectionQuestionType');
const selectionGenStatus = document.getElementById('selectionGenStatus');
const recheckHighlightsBtn = document.getElementById('recheckHighlightsBtn');

const docPanelTitle = document.getElementById('docPanelTitle');
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
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
// Wraps the secret-key label/input/Copy/Regenerate row; hidden in combined mode (Batch C — see quiz-export.js's updateSecretKeyRowVisibility()).
const secretKeyRow = document.getElementById('secretKeyRow');
const secretKeyInput = document.getElementById('secretKeyInput');
// "Keep secret key separate from the code" checkbox; unchecked (default) = combined self-contained Quiz Code (Batch A/C).
const combineKeyToggle = document.getElementById('combineKeyToggle');
const copySecretBtn = document.getElementById('copySecretBtn');
const regenSecretBtn = document.getElementById('regenSecretBtn');
const generateCodeBtn = document.getElementById('generateCodeBtn');
const codeResultBox = document.getElementById('codeResultBox');
const quizCodeOutput = document.getElementById('quizCodeOutput');
const copyCodeBtn = document.getElementById('copyCodeBtn');
// Downloads the generated Quiz Code (or combined key+code string) as a .txt file (Batch C).
const downloadCodeBtn = document.getElementById('downloadCodeBtn');
const modalError = document.getElementById('modalError');

// importDetails now lives in the top nav bar (moved out of the source panel); id is unchanged so this ref still resolves.
const importDetailsEl = document.getElementById('importDetails');

// Wrapper around sourceList; OS file-drop listeners target this so drops still work now that importDetails has moved out.
const sourceStackAreaEl = document.getElementById('sourceStackArea');

// Draggable stack of imported sources rendered by main.js's renderSourceList(); visibility toggled on state.sources.length.
const sourceListEl = document.getElementById('sourceList');

// Source panel column and the grid container it sits in; both take the '.source-panel-expanded' class toggle
// (width-only expand/collapse — see main.js's sourcePanelToggleBtn listener and styles.css's #layoutRoot rules).
const sourcePaneEl = document.getElementById('sourcePane');
const layoutRootEl = document.getElementById('layoutRoot');
const sourcePanelToggleBtn = document.getElementById('sourcePanelToggleBtn');

// Drag-resize handles for Pane 1, the internal pane2/pane3 fr-split, and #motherPane
// (see main.js's setupPaneDrag() and setupInternalSplitDrag() — batches 4 and 5A).
const pane1DividerEl = document.getElementById('pane1Divider');
const pane2DividerEl = document.getElementById('pane2Divider');
const motherPaneDividerEl = document.getElementById('motherPaneDivider');

// Floating shell for Pane 1 — undock/dock toggle, the shell + header + body, and the shell's own
// collapse/dock buttons (batch 5B — see main.js's floatPane1()/dockPane1()/setupFloatShellDrag()).
const pane1FloatToggleBtn = document.getElementById('pane1FloatToggleBtn');
const pane1FloatShell = document.getElementById('pane1FloatShell');
const pane1FloatHeader = document.getElementById('pane1FloatHeader');
const pane1FloatBody = document.getElementById('pane1FloatBody');
const pane1CollapseToggleBtn = document.getElementById('pane1CollapseToggleBtn');
const pane1DockBtn = document.getElementById('pane1DockBtn');

// Term nav bar panel and the filtered-term indicator strip; see editor-render.js's renderTermBar().
const termBarEl = document.getElementById('termBar');
const termFilterIndicatorEl = document.getElementById('termFilterIndicator');

// Scope toggle (all vs. active-page-only) and live term-search input for the term panel.
const termScopeToggleEl = document.getElementById('termScopeToggle');
const termSearchInputEl = document.getElementById('termSearchInput');
const termPanelPopup = document.getElementById('termPanelPopup');
const termPanelToggleBtn = document.getElementById('termPanelToggleBtn');

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
  providerSelect,
  apiKeyRow,
  modelSelectRow,
  endpointRow,
  endpointUrlInput,
  endpointModelInput,
  endpointModelList,
  detectEndpointModelsBtn,
  providerHelp,
  qwenRow,
  qwenModelSelect,
  qwenLoadBtn,
  qwenCancelBtn,
  qwenUnloadBtn,
  qwenProgressWrap,
  qwenProgressBar,
  qwenStatusEl,
  qwenLayoutToggle,
  docTextViewport,
  docTextContainer,
  selectionToolbar,
  selectionGenerateBtn,
  selectionQuestionType,
  selectionGenStatus,
  recheckHighlightsBtn,
  docPanelTitle,
  prevPageBtn,
  nextPageBtn,
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
  secretKeyRow,
  secretKeyInput,
  combineKeyToggle,
  copySecretBtn,
  regenSecretBtn,
  generateCodeBtn,
  codeResultBox,
  quizCodeOutput,
  copyCodeBtn,
  downloadCodeBtn,
  modalError,
  importDetailsEl,
  sourceStackAreaEl,
  sourceListEl,
  sourcePaneEl,
  layoutRootEl,
  sourcePanelToggleBtn,
  pane1DividerEl,
  pane2DividerEl,
  motherPaneDividerEl,
  motherPaneEl,
  pane1FloatToggleBtn,
  pane1FloatShell,
  pane1FloatHeader,
  pane1FloatBody,
  pane1CollapseToggleBtn,
  pane1DockBtn,
  termBarEl,
  termFilterIndicatorEl,
  termScopeToggleEl,
  termSearchInputEl,
  termPanelPopup,
  termPanelToggleBtn,
};
