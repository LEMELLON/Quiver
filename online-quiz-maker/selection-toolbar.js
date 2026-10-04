// --- Shared dependencies ---
import { state } from './core-state.js';
import {
  selectionToolbar,
  selectionGenerateBtn,
  docTextContainer,
  docTextViewport,
} from './dom-refs.js';

import {
  setPendingSelection,
  setLastDocSelection,
} from './core-state.js';

// Functions from other modules that these listeners call:
import { renderSourcePage } from './doc-pane-navigation.js';
import { MIN_CREATE_SELECTION_LEN } from './shared-constants.js';

// Batch 9: touch support state.
// mouseIsDown stops the debounced selectionchange path from firing mid-drag with a mouse.
// toolbarInteractUntil stops it from hiding the toolbar (and clearing the pending selection) while a finger is on the toolbar itself —
// on some phones pressing a button collapses the text selection a moment before the click arrives.
let mouseIsDown = false;
let toolbarInteractUntil = 0;
const TOOLBAR_TOUCH_GRACE_MS = 800;
const SELECTION_CHANGE_DEBOUNCE_MS = 250;

// keep the toolbar inside narrow screens (its two controls wrap instead of overflowing)
selectionToolbar.style.maxWidth = 'calc(100vw - 16px)';
selectionToolbar.style.flexWrap = 'wrap';

// hides the floating "Generate Question" toolbar and clears the pending selection
function hideSelectionToolbar() {
  selectionToolbar.classList.add('hidden');
  setPendingSelection(null);
}

// places the (fixed-position) toolbar relative to the selection rect, clamped to the viewport.
// Touch devices: below the selection, because the OS selection handles and the Copy/Paste bubble occupy the area on and above it.
// Mouse devices: same spot as before (over the selection's top edge).
function positionSelectionToolbar(rect) {
  selectionToolbar.classList.remove('hidden'); // must be visible to be measured
  const toolbarBox = selectionToolbar.getBoundingClientRect(); // fractional size; offsetWidth rounds down and can overflow by a pixel
  const toolbarW = toolbarBox.width;
  const toolbarH = toolbarBox.height;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

  let top;
  if (coarse) {
    top = rect.bottom + 28;
    if (top + toolbarH > vh - 8) top = Math.max(8, rect.top - toolbarH - 48);
  } else {
    top = Math.max(8, rect.top - 8);
  }
  const left = Math.max(8, Math.min(rect.left, vw - toolbarW - 8));
  // position: fixed is viewport-relative, so no scroll offsets are added.
  selectionToolbar.style.top = top + 'px';
  selectionToolbar.style.left = left + 'px';
}

// captures the current text selection in Pane 2 (if valid). Two jobs (G6):
//   1) capture for the scan buttons: ANY non-empty selection (CPU, AI, 1889 ...) is stored as lastDocSelection;
//   2) the floating "Create Question" toolbar: only for selections of at least MIN_CREATE_SELECTION_LEN characters.
function handleTextSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideSelectionToolbar(); return; }

  const text = sel.toString().trim();
  if (!text) { hideSelectionToolbar(); return; }

  const range = sel.getRangeAt(0);
  if (!docTextContainer.contains(range.commonAncestorContainer)) { hideSelectionToolbar(); return; }

  const anchorEl = range.commonAncestorContainer.nodeType === 1
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  const pageEl = anchorEl ? anchorEl.closest('.doc-page') : null;
  if (!pageEl) { hideSelectionToolbar(); return; }

  const captured = { text, sourcePage: Number(pageEl.dataset.page), sourceId: state.activeSourceId, range: range.cloneRange() };
  setLastDocSelection(captured); // always: the scan buttons read this, whatever the length

  if (text.length < MIN_CREATE_SELECTION_LEN) {
    hideSelectionToolbar(); // short: no create button, and clear any stale longer pending selection
    return;
  }
  setPendingSelection(captured);
  positionSelectionToolbar(range.getBoundingClientRect());
}

docTextContainer.addEventListener('mouseup', handleTextSelection);

// Touch: a long-press / handle drag ends with touchend; the browser finalizes the selection a moment later.
docTextContainer.addEventListener('touchend', () => { setTimeout(handleTextSelection, 60); }, { passive: true });

// Touch and keyboard selection never produce a mouseup, so also react (debounced) to the document's selectionchange.
// Only acts when the selection is inside Pane 2, or when the toolbar is showing and the selection moved away (so it can hide).
let selectionChangeTimer = null;
document.addEventListener('selectionchange', () => {
  if (mouseIsDown || Date.now() < toolbarInteractUntil) return;
  if (selectionChangeTimer) clearTimeout(selectionChangeTimer);
  selectionChangeTimer = setTimeout(() => {
    if (mouseIsDown || Date.now() < toolbarInteractUntil) return;
    const sel = window.getSelection();
    const inPane2 = !!(sel && sel.rangeCount > 0 && docTextContainer.contains(sel.getRangeAt(0).commonAncestorContainer));
    if (inPane2 || !selectionToolbar.classList.contains('hidden')) handleTextSelection();
  }, SELECTION_CHANGE_DEBOUNCE_MS);
});

const markToolbarInteraction = () => { toolbarInteractUntil = Date.now() + TOOLBAR_TOUCH_GRACE_MS; };
selectionToolbar.addEventListener('touchstart', markToolbarInteraction, { passive: true });
selectionToolbar.addEventListener('pointerdown', markToolbarInteraction);

let docTextScrollSyncTimer = null;
// returns the page number of the .doc-page currently centered in the text viewport
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

// on Pane 2 scroll, bring Pane 3 to the page now centered in view (debounced, without scrolling Pane 2 back)
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

document.addEventListener('mousedown', (e) => {
  mouseIsDown = true;
  if (!selectionToolbar.contains(e.target) && e.target !== selectionGenerateBtn) hideSelectionToolbar();
});
document.addEventListener('mouseup', () => { mouseIsDown = false; });

export {
  hideSelectionToolbar,
  handleTextSelection,
  getPageFromTextViewport,
};
