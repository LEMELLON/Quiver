// main.js
// Main orchestrator per MODULARIZATION_SCHEMA.txt module [17]: imports
// every module (so each one's own top-level event-listener wiring runs,
// same as when it all lived in one IIFE), wires the handful of
// listeners/blocks the schema's per-module extraction passes explicitly
// flagged as "not part of this module, leave for the orchestrator", and
// finally runs the original file's closing init calls. Every code body
// below is reproduced verbatim from online-quiz-maker.html — only how
// it's packaged/ordered as an entry module is new.
//
// IMPORT ORDER NOTE (structural, not a logic change): plain `import`
// statements are hoisted and all run, in the order written, before any
// of this file's own top-level code. `seed-api-key.js` (the source
// lines 732-747 block) MUST run before `ai-credentials-and-models.js`
// is loaded, because that module's own bottom-of-file block (source
// lines 809-813) immediately reads apiKeyInput.value — so it's imported
// first below. Every other module's own top-level code is either a
// plain function/const declaration or an addEventListener registration
// against elements/functions that already exist by the time any of them
// run, so their relative import order doesn't otherwise matter (same as
// the original file, where they simply ran top-to-bottom in source
// order — the order below matches that source order for clarity, but
// nothing besides the seed/credentials pair above is order-sensitive).

import './core-state.js';
import './dom-refs.js';
import './classification-meta.js';
import './shared-constants.js';

import './seed-api-key.js';
import './ai-credentials-and-models.js';

import { addQuestion, sortQuestionsByPage, updateQuestionCount } from './question-model.js';
import { setParseStatus } from './status-helpers.js';
// UPDATE 2B: renderQuestionNav added to this existing import — the new
// draggable source stack's drop handler (renderSourceList(), below)
// calls it after a reorder so Q01/Q02/... numbering picks up the new
// state.sources order immediately (sortQuestionsByPage() is already
// source-order-aware as of 2A).
import { setActiveCard, renderQuestionNav } from './editor-render.js';
import { extractPptxPages, extractPdfPages } from './doc-extraction.js';
import './text-normalize.js';
// HIGHLIGHT_DUPLICATE_SHARED_MARK_FIX_PROMPT.md: named import (was a bare
// './highlighting.js' side-effect-only import) so the mark click handler
// below can resolve a shared mark's qid list via markQidList.
import { markQidList } from './highlighting.js';
import { renderTextVersion, formatAllPagesLayout } from './layout-formatting.js';
import './selection-toolbar.js';
import './variant-generation.js';
import './snippet-question-generation.js';
import './ai-prompt-builders.js';
import { generateQuestionsWithAI } from './ai-api-calls.js';
// UPDATE2_SLIDE_PANE_PROMPT.md: renderDocPage added to this existing
// import — the source-stack click-to-open handler (openSource(), below)
// calls it, reusing the exact function the old renderSourceList()
// comment already flagged for this ("needs setupNavRange() +
// renderSourcePage() (doc-pane-navigation.js)").
import { setupNavRange, renderDocPage } from './doc-pane-navigation.js';
import './quiz-export.js';
import './batch-scan.js';
// UPDATE2_SLIDE_PANE_PROMPT.md: source-stack thumbnail generation for
// pptx sources — see ensureSourceThumbnail()/generatePptxThumbnail()
// below, and pptx-render.js's own note on why this reuses Tier 2's
// cheap embedded-image extraction rather than Tier 1's full render.
import { getPptxThumbnailDataUrl } from './pptx-render.js';

// UPDATE 2A: createSource() is the multi-source shim's explicit
// "start a new document entry" call — see core-state.js.
import { state, createSource } from './core-state.js';
import {
  docTextContainer,
  pdfFileInput,
  quizTitleInput,
  docPanelTitle,
  pdfEmptyState,
  pdfCanvas,
  slideTextPreview,
  importDetailsEl,
  sourceStackAreaEl,
  sourceListEl,
} from './dom-refs.js';

// FLAGGED IN: layout-formatting.js, selection-toolbar.js — sits between
// the two modules' source line ranges, wires only setActiveCard (not any
// function belonging to either module), and isn't listed under any
// module in MODULARIZATION_SCHEMA.txt's proposed-modules section.
// ---------------------------------------------------------------------
// Verbatim from source, lines 3004-3007
// ---------------------------------------------------------------------
docTextContainer.addEventListener('click', (e) => {
  const mark = e.target.closest('mark[data-qid]');
  // HIGHLIGHT_DUPLICATE_SHARED_MARK_FIX_PROMPT.md: a shared mark (two
  // duplicate-flagged questions' overlapping source-passage highlight —
  // see the multi-qid mark helpers in highlighting.js) can carry more
  // than one qid in its space-separated data-qid list. setActiveCard()
  // takes a single id, so clicking activates the FIRST id in that list —
  // an arbitrary but deterministic choice (unlike the old nested-mark
  // behavior, which activated whichever question happened to render
  // LAST, since that mark visually covered the other).
  if (mark) setActiveCard(markQidList(mark)[0]);
});

// FLAGGED IN: ai-api-calls.js — sits immediately after
// generateQuestionsWithAI and calls it, but its primary job (parsing the
// uploaded file, via extractPptxPages/extractPdfPages) plus its use of
// functions from doc-extraction, layout-formatting, question-model,
// doc-pane-navigation, and editor-render together meant it wasn't a
// clean fit for any single module in the schema's proposed-modules list.
//
// UPDATE 2A (new feature work — see UI_UPGRADES_HANDOFF_PROMPT.md):
// originally handled exactly one file (`e.target.files[0]`) and fully
// REPLACED whatever document/questions existed. `pdfFileInput` now has
// the `multiple` attribute (see online-quiz-maker.html), and this
// handler loops over every selected file, giving each its own
// state.sources[] entry via createSource() rather than clobbering the
// previous one. The per-file body inside the loop (extract -> format
// layout in background -> generate AI questions) is the SAME sequence
// as before, just re-run per file with that file's source active.
//
// Design decisions made explicit here (not fully spelled out in the
// wireframe/handoff):
//  - Whichever file finishes processing LAST ends up the active source,
//    so Pane 1/2/3 end up showing it once the whole batch completes —
//    same "most-recently-imported is what you see" feel as today's
//    single-file behavior, just extended to a batch. Update 2B's
//    drag-to-reorder stack is what gives the person explicit control
//    over this afterward.
//  - The very first file ever imported into an empty state.sources
//    REPLACES state.questions (`state.questions = generated`) — byte-
//    identical to the original single-file behavior, including
//    discarding the one blank question main.js's own init `addQuestion()`
//    call below always adds on page load. Every file after that first
//    one — whether later in the same multi-select, or a completely
//    separate later import — APPENDS its generated questions instead
//    (`state.questions = state.questions.concat(generated)`), since
//    there are now other sources' questions worth keeping.
//  - A file that fails to parse (wrong type, extraction error, empty
//    document) is skipped with its own status message; the rest of the
//    batch still runs rather than the whole selection aborting.
// ---------------------------------------------------------------------
// Verbatim from source, lines 4431-4498 (including importDetailsEl,
// declared inline here in the source — see the NOTE in dom-refs.js for
// why its declaration itself was still centralized there) for the
// per-file body; the surrounding loop/batch bookkeeping is new.
// ---------------------------------------------------------------------
// UPDATE2_SLIDE_PANE_PROMPT.md item 3 (drag-and-drop file import): this
// used to be the `pdfFileInput` 'change' listener's own body inline.
// Factored out into a standalone `importFiles(fileList)` function —
// unchanged logic, just callable from more than one place — so the new
// OS-file-drop listeners further down (see importDetailsEl's
// dragover/drop) can run the exact same import pipeline instead of
// duplicating it. `pdfFileInput`'s own 'change' listener is now just a
// one-line adapter that hands its FileList to this function.
// ---------------------------------------------------------------------
async function importFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  const isFirstImportBatch = state.sources.length === 0;
  let questionsReplaced = false;
  let lastFile = null;
  let lastGenerated = null;
  let sawError = false;

  for (const file of files) {
    const isPptx = /\.pptx$/i.test(file.name) || (file.type || '').includes('presentation');
    const isPdf = /\.pdf$/i.test(file.name) || (file.type || '') === 'application/pdf';
    if (!isPptx && !isPdf) {
      setParseStatus(`Skipped "${file.name}" — please choose a .pdf or .pptx file.`, 'error');
      sawError = true;
      continue;
    }

    setParseStatus(files.length > 1 ? `Reading "${file.name}"…` : 'Reading file…');
    try {
      // UPDATE 2A: this file gets its own state.sources[] entry and
      // becomes the active one, so every state.pages/docType/pdfDoc/
      // pptxFile/pptxZip write below (via core-state.js's shim) lands
      // on THIS file's source, not whichever was active a moment ago.
      createSource(file.name);

      let pages;
      if (isPptx) {
        if (typeof JSZip === 'undefined') throw new Error('JSZip failed to load — check your network connection.');
        state.docType = 'pptx';
        setParseStatus(`Extracting slide text from "${file.name}"…`);
        pages = await extractPptxPages(file);
      } else {
        if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js failed to load — check your network connection.');
        if (typeof Tesseract === 'undefined') throw new Error('OCR engine failed to load — check your network connection.');
        state.docType = 'pdf';
        setParseStatus(`Extracting page text from "${file.name}"…`);
        pages = await extractPdfPages(file);
      }

      if (pages.length === 0) throw new Error(`No pages or slides were found in "${file.name}".`);

      // Text is extracted — make it available and kick off AI layout
      // reconstruction right away, in parallel with question generation
      // below, rather than waiting for a manual "Format Layout" click.
      // Intentionally not awaited: it runs in the background and
      // re-renders Pane 2 itself (via formatAllPagesLayout -> renderTextVersion)
      // whenever it finishes, independent of the question-generation flow.
      state.pages = pages;
      formatAllPagesLayout();

      const generated = await generateQuestionsWithAI(pages);

      if (isFirstImportBatch && !questionsReplaced) {
        state.questions = generated; // exact original single-file behavior
        questionsReplaced = true;
      } else {
        state.questions = state.questions.concat(generated);
      }
      sortQuestionsByPage();

      lastFile = file;
      lastGenerated = generated;
      renderSourceList();
    } catch (err) {
      console.error(err);
      sawError = true;
      setParseStatus(`"${file.name}": ${err.message || 'Failed to parse that document.'}`, 'error');
    }
  }

  if (!lastFile) return; // every file in this selection was skipped or failed

  state.activeCardId = null;
  quizTitleInput.value = lastFile.name.replace(/\.(pdf|pptx)$/i, '');
  docPanelTitle.textContent = lastFile.name;

  setupNavRange();
  pdfEmptyState.classList.add('hidden');
  if (state.docType === 'pdf') {
    pdfCanvas.classList.remove('hidden');
    slideTextPreview.classList.add('hidden');
  } else {
    pdfCanvas.classList.add('hidden');
    slideTextPreview.classList.remove('hidden');
  }

  renderTextVersion();
  updateQuestionCount();
  if (lastGenerated && lastGenerated.length) setActiveCard(lastGenerated[0].id);
  // UPDATE2_SLIDE_PANE_FIX_PROMPT.md: this used to also hide the source
  // stack, since #sourceList was a descendant of #importDetails — now
  // that they're siblings under #sourceStackArea (see
  // online-quiz-maker.html / dom-refs.js), collapsing this <details>
  // only tucks away the API-key/model/file-input controls; the stack
  // stays visible regardless.
  importDetailsEl.open = false;

  if (!sawError) {
    setParseStatus(
      files.length > 1
        ? `Imported ${files.length} file${files.length === 1 ? '' : 's'}.`
        : `Generated ${lastGenerated.length} question${lastGenerated.length === 1 ? '' : 's'} from "${lastFile.name}".`,
      'success'
    );
  }
}

// UPDATE2_SLIDE_PANE_PROMPT.md item 4 (mixed file type handling):
// verified by re-reading the loop above rather than a live browser test
// (no network/display in this environment — same caveat pptx-render.js's
// own header already states about its own untested paths). The loop
// branches per-file on `isPptx`/`isPdf` (regex on the name + MIME-type
// check) independently for EVERY file in `files`, and `pdfFileInput`'s
// `accept` attribute (online-quiz-maker.html) already lists both PDF and
// PPTX MIME types/extensions together — nothing in the loop, in
// createSource(), or in the state.sources[]/state.pages shim
// (core-state.js) assumes a single docType for the whole batch, since
// each iteration re-points state.activeSourceId at that file's own fresh
// source before touching state.docType/pages/etc. So a single
// selection/drop mixing PDFs and PPTXs should already import both types
// correctly, file by file — please still confirm with an actual mixed
// selection in a real browser, since "should" here is a code-level
// verification, not a run one.
pdfFileInput.addEventListener('change', (e) => {
  importFiles(e.target.files);
});

// UPDATE2_SLIDE_PANE_PROMPT.md item 3 (drag-and-drop file import), as
// retargeted by UPDATE2_SLIDE_PANE_FIX_PROMPT.md: lets a person drag
// actual files from the OS onto the source-stack area to import them,
// in addition to the "Choose file(s)" input above.
//
// Listens on `sourceStackAreaEl` — the wrapper around BOTH
// `importDetailsEl` and `sourceListEl` (see online-quiz-maker.html and
// dom-refs.js) — rather than on `importDetailsEl` alone (this
// function's own original version) or on `sourceListEl` alone.
// Retargeted for two reasons, both from the DOM-nesting fix:
//  - `sourceListEl` is `display:none` (see renderSourceList()) until at
//    least one source has already been imported, so it alone still
//    isn't a valid drop target for the very first file.
//  - `importDetailsEl` alone WOULD have been enough back when
//    `sourceListEl` was still its descendant, but the fix moved
//    `sourceListEl` OUT of `importDetailsEl` specifically so
//    `importDetailsEl.open = false` (below, run after every import)
//    stops hiding the stack — which means `importDetailsEl` no longer
//    visually covers `sourceListEl` either, so a drop zone scoped to
//    just `importDetailsEl` would leave the now-separate, always-visible
//    stack unable to accept a file dropped directly onto it.
// `sourceStackAreaEl` covers both pieces with one always-visible,
// collapse-independent target, regardless of what the reader here
// might guess `importDetailsEl.open` currently equals.
//
// This still means the existing drag-**reorder** listeners on
// `sourceListEl` (dragstart/dragend/dragover/drop, further below) don't
// need ANY changes to branch on "is this an OS file drop" — per the
// hard constraint against touching that confirmed-working code. A real
// OS file drag never fires this app's own 'dragstart' listener (that
// only ever fires for a drag that begins on a '.source-stack-item'
// row), so `dragSourceRowId` stays null for it; the reorder 'drop'
// handler's own `if (!dragSourceRowId) return;` guard already no-ops
// harmlessly for an OS-file drop that happens to land on `sourceListEl`
// and bubble up to this listener, and the reorder 'dragover' handler's
// own `!draggingRow` check does the same for dragover. No explicit
// Files-vs-reorder branching was needed inside those handlers — this
// listener only ever positively opts IN via
// `e.dataTransfer.types.includes('Files')`, so it never fires for an
// internal row-reorder drag either.
if (sourceStackAreaEl) {
  const isFileDrag = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));

  sourceStackAreaEl.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    sourceStackAreaEl.classList.add('source-dropzone-active');
  });

  sourceStackAreaEl.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); // required for this element to accept a drop at all
    e.dataTransfer.dropEffect = 'copy';
    sourceStackAreaEl.classList.add('source-dropzone-active');
  });

  sourceStackAreaEl.addEventListener('dragleave', (e) => {
    // Only clear the highlight once the drag actually leaves the whole
    // wrapper, not just moves between its children (dragleave fires on
    // every such move too).
    if (e.target === sourceStackAreaEl) sourceStackAreaEl.classList.remove('source-dropzone-active');
  });

  sourceStackAreaEl.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    sourceStackAreaEl.classList.remove('source-dropzone-active');
    importFiles(e.dataTransfer.files);
  });
}

// UPDATE 2B (new, not from source — see UI_UPGRADES_HANDOFF_PROMPT.md,
// Update 2B item 1): replaces 2A's placeholder, non-draggable list with
// the real PowerPoint-slide-sorter-style draggable stack — filename +
// question count per card, a stacked-boxes drag handle per the
// wireframe, wired to reorder state.sources and re-trigger
// sortQuestionsByPage() + a nav-chip re-render on drop (2A already made
// sortQuestionsByPage() source-order-aware specifically for this).
// Still built with DOM APIs (not innerHTML) so a filename with
// HTML-special characters can't be misinterpreted as markup — same
// convention as 2A's version of this function.
//
// Kept in main.js rather than moved to editor-render.js (which the
// handoff doc's "files to send" list names for this session, alongside
// main.js "for reference" only): the render/reorder logic here reads
// and writes state.sources/state.activeSourceId bookkeeping that
// already lived in this file's file-input handler above, and doesn't
// touch anything editor-render.js owns except calling its already-
// exported renderQuestionNav() once, on drop — so relocating it would
// add a new cross-module surface for no behavioral benefit. Flagging
// this as a deliberate deviation from that file list rather than a
// silent one, per this codebase's own "flag it" convention.
//
// UPDATE2_SLIDE_PANE_PROMPT.md item 2 (click-to-open) — this is the
// follow-up the comment above used to flag as "explicitly not done
// here." Clicking a card now:
//  - makes that source active (state.activeSourceId)
//  - navigates Pane 3 to its page 1, and re-renders Pane 2 for it
//    (setupNavRange() + renderDocPage(1) + renderTextVersion(), exactly
//    the trio the old comment already named)
//  - opens the FIRST question belonging to that source in the editor,
//    which the old comment didn't cover (that ask came in this session).
//
// Order note: renderDocPage(1) runs first, per the prompt's own
// wording. setActiveCard() below, however, ALWAYS re-navigates Pane 3
// to ITS question's own sourcePage internally (see editor-render.js) —
// so if this source's first question isn't actually on page 1, Pane 3
// ends up on that question's page instead, superseding the page-1 nav
// that just ran. That's expected, not a bug: state.questions is already
// kept sourcePage-sorted within a source (sortQuestionsByPage()), so the
// first question is rarely far from page 1, and landing on the actual
// first question's page is the more useful outcome anyway.
function openSource(sourceId) {
  const source = state.sources.find(s => s.id === sourceId);
  if (!source) return;

  state.activeSourceId = sourceId;
  renderSourceList(); // updates which card shows the "active" styling

  setupNavRange();
  renderDocPage(1);
  renderTextVersion();

  // Already sourcePage-sorted within a source per sortQuestionsByPage()
  // (see UPDATE 2A) — the first match is the lowest sourcePage.
  const firstQuestion = state.questions.find(q => q.sourceId === sourceId);
  if (firstQuestion) setActiveCard(firstQuestion.id);
}

// UPDATE2_SLIDE_PANE_PROMPT.md item 1 (thumbnail caching) — generates
// and caches each source's slide-sorter thumbnail ONCE, lazily, the
// first time renderSourceList() draws a card that doesn't have one yet.
// Cached onto `source.thumbnailDataUrl` (a plain extra field on the
// source object — not one of core-state.js's SHIMMED_SOURCE_KEYS, so no
// active/inactive-source ambiguity: this is always THIS source's own
// thumbnail) so every later renderSourceList() redraw (reorder, another
// file imported, a click activating a different card) reuses the cached
// string instead of re-rendering a PDF page or re-parsing a pptx zip
// from scratch again — see the prompt's own "don't re-render on every
// list redraw" instruction.
//
// `source._thumbnailPromise` guards against kicking off a second,
// redundant generation if renderSourceList() happens to redraw again
// (e.g. another file in the same batch finishing) while the first
// generation for this source is still in flight. `source.thumbnailFailed`
// remembers a failure (e.g. a text-only pptx slide with no embedded
// picture — see pptx-render.js's getPptxThumbnailDataUrl) so a
// permanently-thumbnail-less source doesn't retry forever on every
// redraw; the card falls back to a plain type badge in that case
// instead.
function ensureSourceThumbnail(source) {
  if (source.thumbnailDataUrl || source.thumbnailFailed || source._thumbnailPromise) return;

  source._thumbnailPromise = (async () => {
    let dataUrl = null;
    if (source.docType === 'pdf') {
      dataUrl = await generatePdfThumbnail(source);
    } else if (source.docType === 'pptx') {
      dataUrl = await generatePptxThumbnail(source);
    }
    source._thumbnailPromise = null;
    if (dataUrl) {
      source.thumbnailDataUrl = dataUrl;
    } else {
      source.thumbnailFailed = true;
    }
    renderSourceList(); // swap the loading placeholder for the real thumbnail (or the failure badge)
  })();
}

// PDF thumbnail: pdf.js's page.render() — the same primitive
// doc-pane-navigation.js's renderSourcePage() already uses for the
// full-size pdfCanvas — just at a small scale onto an off-screen canvas
// instead. Reads `source.pdfDoc`/`source.pages` directly (NOT the
// state.pdfDoc/state.pages shim) so this always renders THIS source's
// first page regardless of which source happens to be active right now.
async function generatePdfThumbnail(source) {
  if (!source.pdfDoc) return null;
  try {
    const firstPageNumber = source.pages[0] ? source.pages[0].pageNumber : 1;
    const page = await source.pdfDoc.getPage(firstPageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    // Rendered at 2x the ~64px CSS display width (see styles.css's
    // .source-stack-thumb) for a crisper result on high-DPI screens.
    const targetWidth = 128;
    const scale = targetWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL('image/png');
  } catch (e) {
    console.error('[main] PDF thumbnail render failed:', e);
    return null;
  }
}

// PPTX thumbnail: delegates to pptx-render.js's getPptxThumbnailDataUrl
// — see that file for the Tier 1 vs Tier 2 trade-off this makes.
async function generatePptxThumbnail(source) {
  if (!source.pptxZip) return null;
  const firstPageNumber = source.pages[0] ? source.pages[0].pageNumber : 1;
  return getPptxThumbnailDataUrl(source.pptxZip, firstPageNumber);
}

// UPDATE 2B (new, not from source — see UI_UPGRADES_HANDOFF_PROMPT.md,
// Update 2B item 1): PowerPoint-slide-sorter-style draggable stack —
// UPDATE2_SLIDE_PANE_PROMPT.md item 1 adds each card's thumbnail (see
// the thumb-building block below); filename + question count still sit
// beside it, same as 2B's original text-only version. Still built with
// DOM APIs (not innerHTML) so a filename with HTML-special characters
// can't be misinterpreted as markup — same convention as 2B's version.
//
// Kept in main.js rather than moved to editor-render.js, for the same
// reason 2B's version was: see the block comment above this function's
// previous form (now superseded by this one) — the render/reorder/
// thumbnail-cache bookkeeping here reads and writes state.sources
// directly and doesn't touch anything editor-render.js owns beyond its
// already-exported renderQuestionNav()/setActiveCard().
function renderSourceList() {
  if (!sourceListEl) return;
  sourceListEl.innerHTML = '';
  if (state.sources.length === 0) {
    sourceListEl.classList.add('hidden');
    return;
  }
  sourceListEl.classList.remove('hidden');
  state.sources.forEach((source) => {
    const count = state.questions.filter(q => q.sourceId === source.id).length;
    const row = document.createElement('div');
    row.className = 'source-stack-item' + (source.id === state.activeSourceId ? ' source-stack-item-active' : '');
    row.draggable = true;
    row.dataset.sourceId = source.id;

    // UPDATE2_SLIDE_PANE_PROMPT.md item 1 — the thumbnail preview of
    // this source's first page/slide. Three states: cached image ready,
    // still loading (kicks off generation via ensureSourceThumbnail(),
    // which is a no-op if generation is already cached/in-flight/failed —
    // see that function), or permanently failed (a plain type badge,
    // e.g. a text-only pptx slide with no embedded picture — see
    // pptx-render.js's getPptxThumbnailDataUrl).
    const thumb = document.createElement('div');
    thumb.className = 'source-stack-thumb';
    if (source.thumbnailDataUrl) {
      const img = document.createElement('img');
      img.src = source.thumbnailDataUrl;
      img.alt = '';
      thumb.appendChild(img);
    } else if (source.thumbnailFailed) {
      thumb.classList.add('source-stack-thumb-fallback');
      thumb.textContent = source.docType === 'pptx' ? 'SLIDE' : 'PDF';
    } else {
      thumb.classList.add('source-stack-thumb-loading');
      ensureSourceThumbnail(source);
    }
    row.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'source-stack-meta';

    const handle = document.createElement('span');
    handle.className = 'source-stack-handle';
    handle.textContent = '⠿';
    handle.setAttribute('aria-hidden', 'true');
    handle.title = 'Drag to reorder';

    const name = document.createElement('span');
    name.className = 'source-list-name';
    name.textContent = source.name;

    const countEl = document.createElement('span');
    countEl.className = 'source-list-count';
    countEl.textContent = count + (count === 1 ? ' question' : ' questions');

    meta.appendChild(handle);
    meta.appendChild(name);
    meta.appendChild(countEl);
    row.appendChild(meta);

    sourceListEl.appendChild(row);
  });
}

// UPDATE 2B (new, not from source): native HTML5 drag-and-drop for the
// stack above — no drag/sort library is loaded anywhere in this app,
// and the interaction is simple enough (reorder a short flat list) not
// to warrant pulling one in. Delegated on sourceListEl itself rather
// than bound per-row, since renderSourceList() above tears down and
// rebuilds every row on each call — per-row listeners would silently
// leak (old rows garbage-collect fine since they're detached, but new
// rows would never get one without this being delegated).
//
// dragover moves the dragged row's actual DOM node live, so the stack
// visually reorders as you drag it — same feel as a real slide-sorter —
// rather than only showing the result after you let go. drop is what
// commits that DOM order back into state.sources for real and kicks
// off the renumbering.
let dragSourceRowId = null;

if (sourceListEl) {
  // UPDATE2_SLIDE_PANE_PROMPT.md item 2 — click-to-open. Ignores clicks
  // on the drag handle itself (per the prompt: "clicking a card (not
  // its drag handle)") since that's a pure drag affordance, not
  // something a click on should activate the card. Safe to add
  // alongside `draggable = true` on the whole row: a native HTML5 drag
  // only starts once the pointer has actually moved past a threshold,
  // so an ordinary click (press+release with no real drag) still fires
  // this listener normally and a completed drag-drop reorder does not
  // additionally fire a spurious click.
  sourceListEl.addEventListener('click', (e) => {
    if (e.target.closest('.source-stack-handle')) return;
    const row = e.target.closest('.source-stack-item');
    if (!row) return;
    openSource(row.dataset.sourceId);
  });

  sourceListEl.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.source-stack-item');
    if (!row) return;
    dragSourceRowId = row.dataset.sourceId;
    row.classList.add('source-stack-item-dragging');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });

  sourceListEl.addEventListener('dragend', (e) => {
    const row = e.target.closest('.source-stack-item');
    if (row) row.classList.remove('source-stack-item-dragging');
    dragSourceRowId = null;
  });

  sourceListEl.addEventListener('dragover', (e) => {
    e.preventDefault(); // required for this element to accept a drop at all
    const overRow = e.target.closest('.source-stack-item');
    const draggingRow = sourceListEl.querySelector('.source-stack-item-dragging');
    if (!overRow || !draggingRow || overRow === draggingRow) return;
    const rect = overRow.getBoundingClientRect();
    const insertBefore = (e.clientY - rect.top) < rect.height / 2;
    sourceListEl.insertBefore(draggingRow, insertBefore ? overRow : overRow.nextSibling);
  });

  sourceListEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragSourceRowId) return;
    const orderedIds = Array.from(sourceListEl.querySelectorAll('.source-stack-item')).map(el => el.dataset.sourceId);
    state.sources.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
    sortQuestionsByPage();
    renderQuestionNav();
    renderSourceList();
  });
}

// ---------- Init ----------
// ---------------------------------------------------------------------
// Verbatim from source, lines 4941-4943
// ---------------------------------------------------------------------
renderTextVersion();
addQuestion();
