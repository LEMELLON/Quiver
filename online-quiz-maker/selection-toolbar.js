// selection-toolbar.js
// Extracted verbatim from online-quiz-maker.html, source lines 3010-3088
// (hideSelectionToolbar through the document-level mousedown listener
// that dismisses the toolbar on an outside click). Function bodies are
// UNCHANGED from source — only import/export wrapper lines were added.
// See the NOTE block below for the one spot where ES-module mechanics
// required a small, clearly-flagged structural addition (not a logic
// change) to keep shared state working across module boundaries.
//
// FLAGGED (not moved here, not part of this module): source lines
// 3004-3007 —
//   docTextContainer.addEventListener('click', (e) => {
//     const mark = e.target.closest('mark[data-qid]');
//     if (mark) setActiveCard(mark.dataset.qid);
//   });
// This listener sits directly above this section's own
// "---------- Selection -> floating "Generate Question" toolbar ----------"
// banner comment, but it isn't part of that section (it wires
// setActiveCard, not any function here) and isn't assigned to any module
// in MODULARIZATION_SCHEMA.txt's proposed-modules list. Already flagged
// once, in layout-formatting.js's header (the module directly preceding
// it in source order) — not duplicated here, just noted again for
// visibility since it falls between these two modules' line ranges.
//
// The event listeners below (mouseup on docTextContainer, scroll on
// docTextViewport, mousedown on document) are included in this module
// per the "move with handler" strategy: each wires up a function defined
// here (handleTextSelection, hideSelectionToolbar, getPageFromTextViewport),
// even though the scroll listener also calls renderSourcePage from
// doc-pane-navigation.js — same cross-module-call pattern already used
// elsewhere (e.g. highlighting.js's recheckHighlights calling
// cleanExtractedText from snippet-question-generation.js).

// --- Shared dependencies ---
import { state } from './core-state.js';
import {
  selectionToolbar,
  selectionGenerateBtn,
  docTextContainer,
  docTextViewport,
} from './dom-refs.js';

// NOTE (structural, not a logic change): `pendingSelection` and
// `lastDocSelection` (source lines 647-648) are module-level `let`s that
// source code reassigns from BOTH this module (hideSelectionToolbar /
// handleTextSelection below) AND snippet-question-generation.js
// (source lines ~3796-3882, e.g. `lastDocSelection = null;` and reading
// `pendingSelection`'s destructured fields). Same ES-module read-only-
// binding issue already flagged for `duplicateMap` in question-model.js
// and editor-render.js: a module that only `import`s a value cannot
// reassign it the way the original single-scope code did. To keep every
// read/write site working without touching the logic inside any
// function, both now live in core-state.js with getter/setter pairs, and
// the three assignment sites in this file (`pendingSelection = null;`,
// `pendingSelection = captured;`, `lastDocSelection = captured;`) become
// `setPendingSelection(...)` / `setLastDocSelection(...)` calls — the
// only textual changes in this file, both mechanical.
import {
  getPendingSelection,
  setPendingSelection,
  setLastDocSelection,
} from './core-state.js';

// Functions from other modules that these listeners call:
import { renderSourcePage } from './doc-pane-navigation.js';

// ---------------------------------------------------------------------
// Verbatim from source, lines 3010-3013, except the single mechanical
// `pendingSelection = null;` -> `setPendingSelection(null);` substitution
// (see NOTE above).
// ---------------------------------------------------------------------
function hideSelectionToolbar() {
  selectionToolbar.classList.add('hidden');
  setPendingSelection(null);
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 3015-3039, except the two mechanical
// `pendingSelection = captured;` -> `setPendingSelection(captured);` and
// `lastDocSelection = captured;` -> `setLastDocSelection(captured);`
// substitutions (see NOTE above).
// ---------------------------------------------------------------------
function handleTextSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideSelectionToolbar(); return; }

  const text = sel.toString().trim();
  if (text.length <= 10) { hideSelectionToolbar(); return; }

  const range = sel.getRangeAt(0);
  if (!docTextContainer.contains(range.commonAncestorContainer)) { hideSelectionToolbar(); return; }

  const anchorEl = range.commonAncestorContainer.nodeType === 1
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  const pageEl = anchorEl ? anchorEl.closest('.doc-page') : null;
  if (!pageEl) { hideSelectionToolbar(); return; }

  const captured = { text, sourcePage: Number(pageEl.dataset.page), range: range.cloneRange() };
  setPendingSelection(captured);
  setLastDocSelection(captured);

  const rect = range.getBoundingClientRect();
  selectionToolbar.style.top = Math.max(8, rect.top + window.scrollY - 8) + 'px';
  selectionToolbar.style.left = Math.max(8, rect.left + window.scrollX) + 'px';
  selectionToolbar.classList.remove('hidden');
}

// ---------------------------------------------------------------------
// Verbatim from source, line 3041 (event wiring that belongs to this
// module's own function — moved with handler per the schema's strategy)
// ---------------------------------------------------------------------
docTextContainer.addEventListener('mouseup', handleTextSelection);

// ---------------------------------------------------------------------
// Verbatim from source, line 3043
// ---------------------------------------------------------------------
let docTextScrollSyncTimer = null;
// ---------------------------------------------------------------------
// Verbatim from source, lines 3044-3064
// ---------------------------------------------------------------------
function getPageFromTextViewport() {
  const pages = Array.from(docTextContainer.querySelectorAll('.doc-page'));
  if (pages.length === 0) return null;

  const viewportMiddle = docTextViewport.scrollTop + docTextViewport.clientHeight / 2;
  let bestPage = null;
  let bestDistance = Infinity;

  pages.forEach(pageEl => {
    const top = pageEl.offsetTop;
    const bottom = top + pageEl.offsetHeight;
    const center = (top + bottom) / 2;
    const distance = Math.abs(center - viewportMiddle);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPage = Number(pageEl.dataset.page);
    }
  });

  return bestPage;
}

// Text-drives-source direction of the two-way sync: as the user
// scrolls Pane 2 (the text version), figure out which "bond paper"
// page is centered in view and bring Pane 3 (the source PDF/slide)
// to that same page — without scrolling Pane 2 back (scrollText:
// false), since the user's own scroll is already mid-flight there.
// The 120ms debounce plus the `pageNum !== state.currentPage` guard
// keep this from fighting the source→text scroll that renderDocPage
// itself triggers (that scroll settles on the same page number, so
// this listener becomes a no-op once it does).
// ---------------------------------------------------------------------
// Verbatim from source, lines 3075-3084
// ---------------------------------------------------------------------
docTextViewport.addEventListener('scroll', () => {
  hideSelectionToolbar();
  if (docTextScrollSyncTimer) clearTimeout(docTextScrollSyncTimer);
  docTextScrollSyncTimer = setTimeout(() => {
    const pageNum = getPageFromTextViewport();
    if (pageNum && pageNum !== state.currentPage) {
      renderSourcePage(pageNum, { scrollText: false });
    }
  }, 120);
});

// ---------------------------------------------------------------------
// Verbatim from source, lines 3086-3088
// ---------------------------------------------------------------------
document.addEventListener('mousedown', (e) => {
  if (!selectionToolbar.contains(e.target) && e.target !== selectionGenerateBtn) hideSelectionToolbar();
});

export {
  hideSelectionToolbar,
  handleTextSelection,
  getPageFromTextViewport,
};
