# File / Function Map — Online Quiz Maker (Modularized)

Table of contents for the codebase. Status of this doc: **20 of 29 files
confirmed by direct read; 9 files pending** (listed by name only in
upload manifests, content never received — see PENDING section at the
bottom). Every agent that opens a pending file should replace its
placeholder entry here with a real one, in the same format as the
confirmed entries, and flip its status.

Source of truth for original line numbers: `online-quiz-maker.html`
(pre-split monolith), per `MODULARIZATION_SCHEMA.txt`. Not re-verified
here — carried over from each file's own header comment.

---

## Quick index

| File | Role | Status |
|---|---|---|
| core-state.js | shared state object + constants | ✅ confirmed |
| dom-refs.js | all `getElementById` refs | ✅ confirmed |
| pdf-render.js | shared PDF→dataURL canvas helper | ✅ confirmed |
| slide-panel-mirror.js | *(deleted)* — was: live Pane-3 mirror preview | ✅ deleted, dead code confirmed |
| quiz-export.js | JSON export + encrypted Quiz Code export | ✅ confirmed |
| batch-scan.js | "Scan Pages" modal + "Scan This Page" | ✅ confirmed |
| selection-toolbar.js | floating "Generate Question from Selection" toolbar | ✅ confirmed |
| doc-extraction.js | PDF/PPTX → page text extraction (+ OCR) | ✅ confirmed |
| gemini-classifier.js | Gemini/OpenAI key + model detection (IIFE, not ESM) | ✅ confirmed |
| classification-meta.js | TIER_META / VERIFY_META / DATA_STATUS_META constants | ✅ confirmed |
| shared-constants.js | MIN_CHOICES constant | ✅ confirmed |
| seed-api-key.js | page-load init: seeds API key/model inputs | ✅ confirmed |
| text-normalize.js | text→HTML rendering + snippet-matching normalizers | ✅ confirmed |
| status-helpers.js | setParseStatus / setSelectionGenStatus | ✅ confirmed |
| ai-credentials-and-models.js | model dropdown refresh + live key detection | ✅ confirmed |
| config.js | AI_CONFIG defaults (apiKey/model) | ✅ confirmed |
| main.js | app orchestrator, multi-source import flow | ✅ confirmed |
| doc-pane-navigation.js | Pane 3 render/nav, PDF/PPTX slide display | ✅ confirmed |
| online-quiz-maker.html | live HTML shell, loads main.js as module | ⏳ pending |
| editor-render.js | question nav rendering, term bar, escapeHtml | ⏳ pending |
| styles.css | all styling | ⏳ pending |
| question-model.js | question CRUD, dedup, sourceId tagging | ⏳ pending |
| layout-formatting.js | Pane 2 text rendering + highlight redraw; AI layout reformatting | ✅ confirmed |
| pptx-render.js | PPTX slide render (Tier 1 lib render + Tier 2 image grid) | ✅ confirmed |
| highlighting.js | source-text highlight recheck | ✅ confirmed |
| ai-api-calls.js | generateQuestionsWithAI (3-pass pipeline) | ⏳ pending |
| snippet-question-generation.js | single-snippet question generation | ⏳ pending |
| variant-generation.js | single question-variant generation | ⏳ pending |
| ai-prompt-builders.js | prompt construction, collectTargetTerms | ⏳ pending |

---

## Confirmed files

### core-state.js
**Role:** Central shared state object + constants every other module imports.
**Exports:** `PBKDF2_ITERATIONS`, `SALT_LEN`, `IV_LEN`, `state`, `getPendingSelection`/`setPendingSelection`, `getLastDocSelection`/`setLastDocSelection`, `getDuplicateMap`/`setDuplicateMap`, `getActiveSource`, `createSource`, `API_KEY_STORAGE`, `MODEL_STORAGE`, `configDefaults`, `configApiKey`, `configModel`.
**Key internals (not exported):** `state.sources[]` (multi-doc support, each `{id,name,docType,pages,pdfDoc,pptxFile,pptxZip}`), `state.activeSourceId`, `makeBlankSource`, `ensureActiveSource`, `SHIMMED_SOURCE_KEYS` (proxies `state.docType/pages/pdfDoc/pptxFile/pptxZip` onto the active source via `Object.defineProperty`).
**Depends on:** nothing (leaf).
**Read by:** effectively every other module.

### dom-refs.js
**Role:** Every `document.getElementById(...)` ref, declared once.
**Exports:** ~65 DOM element refs (panes, buttons, modals, scan-range fields, term bar, etc. — see file for full list).
**Flag:** exports referenced by `slide-panel-mirror.js` (`slidePanelMirrorEl`, `slidePanelMirrorImg`, `slidePanelMirrorEmpty`, `slidePanelMirrorFallback`) are **not present** in this file's export list — file's own header says these were removed when that feature was reverted.
**Depends on:** nothing (leaf).

### pdf-render.js
**Role:** Shared helper — renders one page of a loaded pdf.js `pdfDoc` to a canvas → PNG data URL.
**Exports:** `renderPdfPageToDataUrl(pdfDoc, pageNumber, targetWidth, opts)`.
**Depends on:** nothing (leaf, pdf.js global only).
**Read by:** `main.js` (thumbnail gen, pending), `slide-panel-mirror.js`.

### slide-panel-mirror.js — DELETED
**Status:** file removed. Dead-code question is closed: `doc-pane-navigation.js` and `main.js` (both confirmed) have no import of this file and no call to `updateSlidePanelMirror()`, matching `core-state.js`/`dom-refs.js`'s claim that the feature was already reverted. No archive kept per the handoff's no-archive rule — this entry is the only remaining record.
**Note for `styles.css` pass (still pending):** check for now-orphaned `#slidePanelMirror` / `.slide-panel-mirror-loading` rules and flag/remove per that file's own workflow step.

### quiz-export.js
**Role:** Build/validate quiz JSON, plain JSON export, and encrypted "Quiz Code" export (PBKDF2 → AES-GCM → gzip → base64url).
**Exports:** `buildQuizObject`, `validateQuiz`, `exportJson`, `bufferToBase64Url`, `gzipCompress`, `deriveKey`, `exportToQuizCode`, `generateSecretKey`, `openModal`, `closeModal`.
**Depends on:** `core-state.js` (`state`, `PBKDF2_ITERATIONS`, `SALT_LEN`, `IV_LEN`), `dom-refs.js` (title input, export/modal buttons+fields).
**Note:** owns its own event-listener wiring for the Quiz Code modal (moved-with-handler).

### batch-scan.js
**Role:** "Scan Pages" range modal + Pane-3 "Scan This Page" shortcut — reruns the AI pipeline scoped to specific pages, appends results.
**Exports:** `applyPreferredQuestionType`, `scanPageRange`, `openScanRangeModal`, `closeScanRangeModal`.
**Internal only:** `getScanTargetSourceId`, `getScanTargetPages`, `populateScanSourcePicker`, `refreshScanRangeBounds`.
**Depends on:** `core-state.js`, `dom-refs.js`, `status-helpers.js` (`setParseStatus`), `variant-generation.js` (pending, `generateSingleVariant`), `ai-prompt-builders.js` (pending, `collectTargetTerms`), `ai-api-calls.js` (pending, `generateQuestionsWithAI`), `question-model.js` (pending, `sortQuestionsByPage`/`updateQuestionCount`), `layout-formatting.js` (pending, `renderTextVersion`), `editor-render.js` (pending, `renderQuestionNav`/`setActiveCard`).
**Known follow-up bug (per its own comment):** scanning a non-active source switches `state.activeSourceId` but does NOT re-sync Pane 3 — left as flagged, not fixed.

### selection-toolbar.js
**Role:** Floating toolbar that appears on text selection in Pane 2, plus the two-way scroll sync (Pane 2 scroll → Pane 3 page).
**Exports:** `hideSelectionToolbar`, `handleTextSelection`, `getPageFromTextViewport`.
**Depends on:** `core-state.js` (`state`, pending-selection getters/setters), `dom-refs.js`, `doc-pane-navigation.js` (pending, `renderSourcePage`).
**Flag (repeated from layout-formatting.js's header, per this file):** source lines 3004-3007 (a `docTextContainer` click listener wiring `setActiveCard`) sit between this module and the previous one and aren't assigned to either — unresolved.

### doc-extraction.js
**Role:** Extracts page text from PDF (pdf.js + Tesseract OCR fallback) and PPTX (JSZip + slide XML parse).
**Exports:** `ocrPdfPage`, `groupTextItemsIntoLines`, `extractPdfPages`, `extractTextFromSlideXml`, `extractPptxPages`.
**Depends on:** `core-state.js` (`state` — sets `state.pdfDoc`/`pptxFile`/`pptxZip` via the SHIMMED_SOURCE_KEYS proxy), `status-helpers.js`. Uses globals `Tesseract`, `pdfjsLib`, `JSZip`, `DOMParser` directly (separate `<script>` tags, no import).

### gemini-classifier.js
**Role:** Standalone IIFE (NOT an ES module) attaching `window.GeminiClassifier` — API key storage, live model discovery (Gemini `/v1beta/models`), OpenAI key-pattern detection, `generateContent` call wrapper.
**Exports (as global, not ESM):** `GeminiClassifier.{setKey, getKey, getMaskedKey, classifyKeyModels, generateContent}`.
**Depends on:** nothing (leaf), uses `localStorage`, `fetch`.
**Note:** fallback Gemini model-ID list is a **hardcoded, date-sensitive value** (currently `gemini-3.7-flash` / `gemini-3.6-flash` / `gemini-3.1-flash-lite`) — flagged in its own comment as something that will go stale again.

### classification-meta.js
**Role:** Shared constant lookup tables for tier/verification/data-status labels+colors.
**Exports:** `TIER_META`, `VERIFY_META`, `DATA_STATUS_META`.
**Depends on:** nothing (leaf). **Read by:** question-model.js, editor-render.js, highlighting.js, snippet-question-generation.js (all pending).

### shared-constants.js
**Role:** Single shared constant.
**Exports:** `MIN_CHOICES` (= 2).
**Depends on:** nothing (leaf). **Read by:** editor-render.js, variant-generation.js (both pending).

### seed-api-key.js
**Role:** Page-load init script (no exports) — seeds `apiKeyInput`/`modelSelect` from localStorage, falling back to `config.js`.
**Exports:** none — runs top-level on import.
**Depends on:** `core-state.js` (`API_KEY_STORAGE`, `MODEL_STORAGE`, `configApiKey`, `configModel`), `dom-refs.js` (`apiKeyInput`, `modelSelect`).
**Ordering constraint (important, don't break on refactor):** must be imported by `main.js` **before** `ai-credentials-and-models.js`, since the latter's own top-level init reads `apiKeyInput.value` expecting it already seeded.

### text-normalize.js
**Role:** Converts extracted page text to HTML (headings/bullets/paragraphs/markdown-lite), plus whitespace/punctuation normalizers used for AI-snippet-to-source matching and term dedup.
**Exports:** `renderInlineMarkdown`, `isLikelyHeading`, `mergeParagraphLines`, `renderPageTextHtml`, `normalizeWhitespace`, `SNIPPET_PUNCTUATION_RE`, `stripPunctuationForMatch`, `stripListConjunctionsForMatch`, `normalizeTermKey`, `lightSingularizeKey`, `normalizeTermKeyLoose`.
**Depends on:** `editor-render.js` (pending, `escapeHtml`).
**Read by (per its own note):** `highlighting.js` (confirmed) also uses `SNIPPET_PUNCTUATION_RE` directly.

### status-helpers.js
**Role:** Two tiny status-line setters, used from ~31 call sites app-wide.
**Exports:** `setParseStatus`, `setSelectionGenStatus`.
**Depends on:** `dom-refs.js` (`parseStatus`, `selectionGenStatus`).

### ai-credentials-and-models.js
**Role:** Model dropdown population + live "detect models for this key" flow; owns the API-key/model input event wiring.
**Exports:** `refreshModelOptions`, `detectModels`.
**Depends on:** `dom-refs.js`, `core-state.js` (`MODEL_STORAGE`, `API_KEY_STORAGE`, `configModel`), global `GeminiClassifier` (from gemini-classifier.js).
**Ordering constraint:** its top-level init block assumes `seed-api-key.js` already ran (see that file's note).

### config.js
**Role:** Default AI provider config, editable by a self-hosting user.
**Exports (as global `const`, script-tag loaded, not ESM import):** `AI_CONFIG = {apiKey, model}`.
**Security note in file:** never commit a real key here; it's visible in browser source.

### doc-pane-navigation.js
**Role:** Pane 3 (source PDF/slide) render + page navigation, plus the two-way scroll sync with Pane 2 (source-drives-text direction). PPTX rendering tries a 3-tier visual fallback (real render → embedded-image grid → plain text).
**Exports:** `setupNavRange`, `scrollDocTextToPage`, `renderSourcePage`, `renderDocPage`, `updateSyncBadge`.
**Internal only:** `renderPptxSlide` (async, drives the 3-tier PPTX fallback chain).
**Depends on:** `core-state.js` (`state`), `dom-refs.js` (nav/pane/pptx-tier DOM refs), `editor-render.js` (`renderPane3QuestionNav`, `renderTermBar` — both pending), `pptx-render.js` (`renderPptxTier1`, `renderPptxTier2`, `teardownTier1Scaling` — pending).
**Cross-source rollover (UPDATE 2A):** paging past a source's last/first page now recurses into the next/previous entry in `state.sources` instead of clamping, falling back to the original clamp when there's no neighboring source.
**slide-panel-mirror.js resolution:** confirmed — this file has **no** call to `updateSlidePanelMirror()`; its header explicitly documents the removal. `main.js` (now confirmed, see below) also has no import of or call into `slide-panel-mirror.js`. Special case closed: no live caller exists anywhere in the codebase.

### main.js
**Role:** App orchestrator/entry module. Imports every other module (so each one's own top-level listener wiring runs), owns the handful of listeners/functions that don't belong to any single module, and runs final init.
**Exports:** none (entry module; no other file imports from it).
**Internal only:** `importFiles(fileList)` (multi-file import: extract → background layout format → AI question generation, per file, appending or replacing `state.questions`), `openSource(sourceId)` (activates a source and syncs Panes 2/3 + editor), `ensureSourceThumbnail`/`generatePdfThumbnail`/`generatePptxThumbnail` (lazy per-source thumbnail generation/caching), `renderSourceList` (draggable source-stack UI), plus the file-input, OS drag-drop, and stack-reorder-drag event listeners, and a `docTextContainer` click listener for shared highlight marks.
**Depends on:** `core-state.js`, `dom-refs.js`, `classification-meta.js`, `shared-constants.js`, `seed-api-key.js`, `ai-credentials-and-models.js`, `question-model.js`, `status-helpers.js`, `editor-render.js`, `doc-extraction.js`, `text-normalize.js`, `highlighting.js`, `layout-formatting.js`, `selection-toolbar.js`, `variant-generation.js`, `snippet-question-generation.js`, `ai-prompt-builders.js`, `ai-api-calls.js`, `doc-pane-navigation.js`, `quiz-export.js`, `batch-scan.js`, `pptx-render.js`, `pdf-render.js`. Does **not** import `slide-panel-mirror.js`.
**Confirms:** no live caller of `slide-panel-mirror.js`'s `updateSlidePanelMirror()` anywhere in the codebase (see slide-panel-mirror.js entry above).

### pptx-render.js
**Role:** 3-tier fallback visual renderer for Pane 3 on PPTX imports (Tier 3, plain text, lives in doc-pane-navigation.js). Also generates source-stack thumbnails.
**Exports:** `renderPptxTier1`, `renderPptxTier2`, `teardownTier1Scaling`, `renderPptxTier1Thumbnail`, `getPptxThumbnailDataUrl`.
**Internal only:** `loadPptxRendererModule`, `getPresentationForFile`, `setupTier1ResponsiveScaling`, `resolveSlideImageBlobs`, `getThumbnailMeasureHost`.
**Depends on:** third-party CDN module `@aiden0z/pptx-renderer` (pinned 1.2.0, loaded via jsDelivr `+esm`), globals `JSZip`/`DOMParser`. No import of `core-state.js`/`dom-refs.js` — container/file/zip/pageNumber are all passed in by the caller (doc-pane-navigation.js, main.js).
**Note:** Tier 1 caches one parsed presentation per File-object identity (`getPresentationForFile`) and cancels superseded in-flight renders via `renderToken`; `currentSlideHandle`/`currentTier1ResizeObserver` track the single currently-mounted Pane-3 slide so they can be torn down before the next one replaces it. Thumbnail rendering (`renderPptxTier1Thumbnail`) is a separate, uncancelled one-shot path that keeps its wrapper alive indefinitely (cached by the caller) rather than disposing it.

### layout-formatting.js
**Role:** Rebuilds Pane 2's HTML from `state.pages` and re-applies question/answer highlights (`renderTextVersion`); also owns the AI-powered "Format Layout" flow that reconstructs page layout as sanitized HTML (`formatDocumentLayout`/`formatAllPagesLayout`/`sanitizeLayoutHtml`/`LAYOUT_SYSTEM_PROMPT`).
**Exports:** `renderTextVersion`, `sanitizeLayoutHtml`, `formatDocumentLayout`, `formatAllPagesLayout`.
**Depends on:** `core-state.js`, `dom-refs.js`, `text-normalize.js` (`renderPageTextHtml`), `status-helpers.js` (`setSelectionGenStatus`), `highlighting.js` (`highlightSnippetInContainer`, `recheckHighlights`, `dedupeMarks`, `logAllHighlights`, `locateAndHighlightSnippet`, `markQidList`), `ai-api-calls.js` (`callGeminiApiWithRetry`, `callOpenAiApi`, `sleep`, `isGeminiModelNotFoundError`), `question-model.js` (`computeDuplicateMap` — 2-file import cycle with this file's own `renderTextVersion` export, safe since `computeDuplicateMap` is only invoked from inside a function body, never at module-evaluation time).
**Read by:** `main.js`, `question-model.js`, `highlighting.js`, `selection-toolbar.js` (per its own header note), `batch-scan.js`.
**Flag (repeated from its own file header, not fixed this pass):** source lines 3004-3007 — a `docTextContainer` click listener that calls `setActiveCard` — sit immediately after this file's own event wiring but aren't assigned to any module; likely belongs with `setActiveCard` in `editor-render.js`, or the main orchestrator. Left unassigned per the modularization schema's "flag, don't guess" rule.
**Note:** `renderTextVersion()` still contains two `logAllHighlights(...)` diagnostic calls (`'end of renderTextVersion'` and, via `formatAllPagesLayout`, `'formatAllPagesLayout: after recheckHighlights (final)'`) — left in place since removing them would be a logic change, out of scope for this pass.

---

## Pending files (content not yet received — placeholders only)

Everything below is **inferred from cross-references in the confirmed
files**, not from reading the file itself. Treat as a starting hypothesis
only; the agent who actually opens each file should overwrite this entry.

### online-quiz-maker.html — *not yet reviewed*
The live HTML shell; loads `<script type="module" src="main.js">` (per
dom-refs.js's confirmation this is NOT a legacy monolith despite the
filename). Contains `#sourcePane`, `#pane1/2/3`, scan/quiz-code modals,
term bar markup, etc.

### editor-render.js — *not yet reviewed*
Referenced exports: `escapeHtml` (used by text-normalize.js),
`renderQuestionNav`, `setActiveCard`, `renderPane3QuestionNav`,
`renderTermBar`, `buildTermGroups`, `filterTermGroupsForPanel`. Also
reassigns `duplicateMap` via core-state.js's getter/setter (shared with
question-model.js).

### styles.css — *not yet reviewed*
Referenced classes: `.source-stack-thumb`, `.source-stack-thumb-loading`,
`.source-stack-thumb-fallback`, `#slidePanelMirror`,
`.slide-panel-mirror-loading` (dead-feature CSS, check if still present).

### question-model.js — *not yet reviewed*
Referenced exports: `newQuestion` (tags `sourceId`, per quiz-export.js's
UPDATE 2B note), `sortQuestionsByPage`, `updateQuestionCount`,
`removeFlaggedDuplicates` (reassigns `duplicateMap`).

### highlighting.js — *confirmed*
**Role:** Locates and wraps question/answer snippets in `<mark>` elements in Pane 2, handles duplicate-sharing of
overlapping marks, and drives the batch and single-question highlight recheck flows.
**Exports:** `fuzzyIncludes`, `highlightBlockAncestorOf`, `buildNormalizedContainerIndex`, `stripPunctuationKeepMap`,
`stripListConjunctionsKeepMap`, `highlightSnippetInContainer`, `widenRangeToAvoidPartialMarks`,
`unwrapMarksForQuestion`, `dedupeMarks`, `hasFuzzyMark`, `markedTextLength`, `calculateSimilarity`,
`extractSentences`, `locateAndHighlightSnippet`, `recheckHighlights`, `recheckHighlightsForQuestion`,
`logAllHighlights`, `markQidList`, `markHasQid`, `areDuplicateQids`.
**Depends on:** `core-state.js`, `dom-refs.js`, `classification-meta.js`, `text-normalize.js`, `status-helpers.js`,
`editor-render.js`, `snippet-question-generation.js` (`cleanExtractedText`), `layout-formatting.js`
(`renderTextVersion` — 2-file import cycle, safe since `renderTextVersion()` is only invoked from inside
`recheckHighlights()`'s own function body, never at module-evaluation time).
**Note:** `recheckHighlights()` is intentionally NOT routed through the shared `locateAndHighlightSnippet()` ladder —
its own inline own-page/fuzzy/term-only logic extracts each page's sentences once and scores every open candidate
against them in the same pass (O(pages) instead of O(candidates x pages)); routing it through the per-slot helper
would undo that.

### ai-api-calls.js — *not yet reviewed*
Referenced export: `generateQuestionsWithAI(pages, seedTerms)` — the
3-pass generation pipeline; tags each generated question with
`state.activeSourceId` at creation time (per batch-scan.js's known-bug
note — this is why scanning requires switching active source first).

### snippet-question-generation.js — *not yet reviewed*
Referenced exports: `generateQuestionFromSnippet`, `cleanExtractedText`.
Reassigns `lastDocSelection`/reads `pendingSelection` via core-state.js
getters/setters (shared with selection-toolbar.js).

### variant-generation.js — *not yet reviewed*
Referenced export: `generateSingleVariant(question, type)`. Likely also
owns `isValidChoiceCount` (uses `MIN_CHOICES` from shared-constants.js,
per that file's note).

### ai-prompt-builders.js — *not yet reviewed*
Referenced export: `collectTargetTerms(questions)`.

---

## Cross-file shared state (for quick reference)

- **`state.pendingSelection` / `state.lastDocSelection`** — getter/setter pair in core-state.js; written by selection-toolbar.js and snippet-question-generation.js (pending).
- **`state.duplicateMap`** — getter/setter pair in core-state.js; written by question-model.js (pending) and editor-render.js (pending).
- **`state.docType`/`pages`/`pdfDoc`/`pptxFile`/`pptxZip`** — accessor shim in core-state.js, transparently proxied to `state.sources.find(active)`. Any file reading/writing these as plain properties is unaffected by the multi-source refactor.
- **`state.sources[]` / `state.activeSourceId`** — new in UPDATE 2A; touched directly (not via shim) by main.js (pending), doc-pane-navigation.js (pending), batch-scan.js, quiz-export.js, selection-toolbar.js, slide-panel-mirror.js.
