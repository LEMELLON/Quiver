// dom-refs.js
//
// UPDATE2_SLIDE_PANE_PROMPT.md ("Slide Panel as Its Own Dedicated Layout
// Column") verification note: #sourceStackArea (containing #importDetails
// and #sourceList) moved to its own top-level <section id="sourcePane">
// in online-quiz-maker.html, as a sibling of #pane1/#pane2/#pane3 rather
// than a descendant of #pane1. All three ids are unchanged, and every ref
// below is a plain `document.getElementById(...)` keyed on id, not on any
// assumption about which parent element contains it — so this file needed
// NO changes for the relocation. Confirmed by inspection of every ref
// declared below.
//
// Shared-context module per MODULARIZATION_SCHEMA.txt's "SHARED CONTEXT"
// section — every `document.getElementById(...)` ref, declared once here
// so no other module redefines them. Extracted verbatim from
// online-quiz-maker.html, source lines 650-717, plus one straggler ref
// (see NOTE below). Values are UNCHANGED from source — only import/export
// wrapper lines were added — EXCEPT for `pptxTier1Container` /
// `pptxTier2Container` / `pptxLoadingState`, three new refs added per
// PPTX_RENDER_HANDOFF_PROMPT.md and PPTX_RENDER_FOLLOWUP_PROMPT.md (see
// the note just above their declaration). As of the follow-up pass,
// these elements now DO exist in the live HTML shell
// (online-quiz-maker.html, which — despite its filename and older
// module-banner comments elsewhere calling it "the legacy monolith" —
// is confirmed to be the actual live shell for the modular build: it
// loads `<script type="module" src="main.js">`, not an inline IIFE.
// See PPTX_RENDER_FOLLOWUP_PROMPT.md Fix 1 and this repo's follow-up
// response for details). No HTML changes are needed alongside this file
// anymore for those two; `pptxLoadingState` was added to that same file
// in this same follow-up pass.
//
// NOTE (structural, not a logic change): `importDetailsEl` (source line
// 4498, `const importDetailsEl = document.getElementById('importDetails');`)
// is a `document.getElementById` DOM ref like every other one in this
// file, but it was declared far from the rest — inline in the middle of
// the pdfFileInput 'change' handler that's flagged (in ai-api-calls.js
// and again here) as not-yet-assigned to any module. It genuinely
// belongs with its fellow DOM refs per this module's own stated purpose
// ("every DOM ref, declared once here"), so it's included below rather
// than left to be redeclared wherever that handler eventually lands.
// This is the one spot in the whole extraction where a ref MODULARIZATION_SCHEMA.txt's
// own DOM-refs list (source lines ~648-721) didn't already enumerate —
// verified by grepping every `document.getElementById(` call in the
// source file.

// ---------------------------------------------------------------------
// Verbatim from source, lines 651-717
// ---------------------------------------------------------------------
const pane1 = document.getElementById('pane1');
const pane2 = document.getElementById('pane2');
const pane3 = document.getElementById('pane3');

// Update 1 (paginated nav-chip bar): questionNavGroup wraps questionNav
// + questionNavPager (see online-quiz-maker.html) — added alongside the
// existing questionNav ref rather than replacing it, since questionNav
// itself still exists and still holds just the chip buttons.
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

// Added per PPTX_RENDER_HANDOFF_PROMPT.md / PPTX_RENDER_FOLLOWUP_PROMPT.md
// (see file-header note above) — siblings of slideTextPreview inside
// #pdfViewport: Tier 1 (real visual — hosts the reused, namespace-
// isolated PPTXjs iframe), Tier 2 (embedded-image grid), and a loading
// placeholder shown while Tier 1/2 are being attempted (FOLLOW-UP
// Fix 4). All three start hidden; doc-pane-navigation.js's
// renderPptxSlide() toggles which of these — plus slideTextPreview —
// is visible per slide.
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
// UPDATE 2B (new ref, not from source — see UI_UPGRADES_HANDOFF_PROMPT.md,
// Update 2B item 4): source picker for the Scan Pages modal, so a
// person can target a non-active imported document without switching
// Pane 3 to it first. scanSourceFieldEl is the wrapping <div> (hidden
// entirely when there's 0-1 sources, since a picker with a single
// option is just noise) — see batch-scan.js's populateScanSourcePicker().
const scanSourceSelect = document.getElementById('scanSourceSelect');
const scanSourceFieldEl = document.getElementById('scanSourceField');
const scanFromPage = document.getElementById('scanFromPage');
const scanToPage = document.getElementById('scanToPage');
const scanQuestionType = document.getElementById('scanQuestionType');
const scanRangeHint = document.getElementById('scanRangeHint');
const scanRangeGenerateBtn = document.getElementById('scanRangeGenerateBtn');
const scanRangeStatus = document.getElementById('scanRangeStatus');
const scanRangeError = document.getElementById('scanRangeError');

// ---------------------------------------------------------------------
// Verbatim from source, line 4498 (see NOTE above)
// ---------------------------------------------------------------------
const importDetailsEl = document.getElementById('importDetails');

// UPDATE2_SLIDE_PANE_FIX_PROMPT.md (new ref, not from source): the
// always-visible wrapper around both #importDetails and #sourceList
// (see online-quiz-maker.html) — main.js's OS-file-drop listeners target
// THIS, not importDetailsEl, so dropping a file works regardless of
// whether the Import panel is expanded/collapsed or the stack is
// currently empty/hidden. Introduced by the same fix that moved
// #sourceList out from being a descendant of the collapsible
// <details id="importDetails">, since importDetailsEl.open = false
// (main.js, run after every import) used to collapse the source stack
// along with the panel.
const sourceStackAreaEl = document.getElementById('sourceStackArea');

// UPDATE 2A (new ref, not from source): the draggable slide-sorter stack
// of imported sources main.js renders into — see its renderSourceList().
// UPDATE2_SLIDE_PANE_FIX_PROMPT.md: no longer a descendant of
// importDetailsEl (see sourceStackAreaEl above and the HTML) — its own
// `.hidden` toggle (on state.sources.length === 0) is now the only thing
// controlling its visibility.
const sourceListEl = document.getElementById('sourceList');

// SLIDE_PANEL_MIRROR_REVERT_AND_THUMBNAIL_FIX_PROMPT.md: the
// slidePanelMirrorEl/Img/Empty/Fallback refs that used to live here
// (SLIDE_PANEL_LIVE_MIRROR_PROMPT.md) are removed — that separate
// live-preview element no longer exists in online-quiz-maker.html. The
// real slide panel is #sourceList's per-card thumbnails; see
// sourceListEl below and main.js's renderSourceList().

// UPDATE 3 (new refs, not from source — see UI_UPGRADES_HANDOFF_PROMPT.md
// Update 3): the term nav bar panel and the "showing filtered term"
// indicator strip above the chip grid. See editor-render.js's
// renderTermBar()/buildTermGroups().
const termBarEl = document.getElementById('termBar');
const termFilterIndicatorEl = document.getElementById('termFilterIndicator');

// UPDATE3_TERM_PANE_PROMPT.md (new refs, not from source): the show-all
// vs. active-page-only scope toggle wrapper (its two buttons are read
// via delegated click, same pattern as termBarEl above — no separate
// refs per button) and the live term-search input. Both now live inside
// #termPane rather than #pane1 — see online-quiz-maker.html and this
// same prompt's relocation of #termBarDetails. See editor-render.js's
// renderTermBar()/filterTermGroupsForPanel() for how these drive the
// term list.
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
