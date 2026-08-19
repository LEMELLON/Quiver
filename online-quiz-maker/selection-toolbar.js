// --- Shared dependencies ---
import { state } from './core-state.js';
import {
  selectionToolbar,
  selectionGenerateBtn,
  docTextContainer,
  docTextViewport,
} from './dom-refs.js';

import {
  getPendingSelection,
  setPendingSelection,
  setLastDocSelection,
} from './core-state.js';

// Functions from other modules that these listeners call:
import { renderSourcePage } from './doc-pane-navigation.js';

// hides the floating "Generate Question" toolbar and clears the pending selection
function hideSelectionToolbar() {
  selectionToolbar.classList.add('hidden');
  setPendingSelection(null);
}

// captures the current text selection in Pane 2 (if valid) and positions the floating toolbar over it
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

  const captured = { text, sourcePage: Number(pageEl.dataset.page), sourceId: state.activeSourceId, range: range.cloneRange() };
  setPendingSelection(captured);
  setLastDocSelection(captured);

  const rect = range.getBoundingClientRect();
  selectionToolbar.style.top = Math.max(8, rect.top + window.scrollY - 8) + 'px';
  selectionToolbar.style.left = Math.max(8, rect.left + window.scrollX) + 'px';
  selectionToolbar.classList.remove('hidden');
}

docTextContainer.addEventListener('mouseup', handleTextSelection);

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
  if (!selectionToolbar.contains(e.target) && e.target !== selectionGenerateBtn) hideSelectionToolbar();
});

export {
  hideSelectionToolbar,
  handleTextSelection,
  getPageFromTextViewport,
};
