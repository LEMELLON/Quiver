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
import { setupNavRange } from './doc-pane-navigation.js';
import './quiz-export.js';
import './batch-scan.js';

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
pdfFileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
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
  importDetailsEl.open = false;

  if (!sawError) {
    setParseStatus(
      files.length > 1
        ? `Imported ${files.length} file${files.length === 1 ? '' : 's'}.`
        : `Generated ${lastGenerated.length} question${lastGenerated.length === 1 ? '' : 's'} from "${lastFile.name}".`,
      'success'
    );
  }
});

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
// Explicitly NOT done here (flagging rather than guessing): clicking a
// card to make that source the one shown in Pane 2/3. The wireframe's
// stack strongly suggests that as a natural next affordance, but doing
// it correctly needs setupNavRange() + renderSourcePage()
// (doc-pane-navigation.js) and the pdfCanvas/slideTextPreview
// visibility toggle (currently inlined in this file's own
// pdfFileInput handler, not factored into a reusable function) — none
// of which are safe to guess at blind. Left for a follow-up session
// with doc-pane-navigation.js in scope.
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

    row.appendChild(handle);
    row.appendChild(name);
    row.appendChild(countEl);
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
