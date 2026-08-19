
// --- Shared dependencies ---
import { state } from './core-state.js';
import {
  pageInput,
  prevPageBtn,
  nextPageBtn,
  scanCurrentPageBtn,
  totalPagesEl,
  docTextContainer,
  pdfViewport,
  pdfCanvas,
  slideTextPreview,
  pptxTier1Container,
  pptxTier2Container,
  pptxLoadingState,
  syncBadge,
  syncBadgeText,
} from './dom-refs.js';

// Functions from other modules that these functions call:
import { renderPane3QuestionNav, renderTermBar } from './editor-render.js';
import { renderPptxTier1, renderPptxTier2, teardownTier1Scaling } from './pptx-render.js';

function setupNavRange() {
  if (state.pages.length === 0) return;
  const first = state.pages[0].pageNumber;
  const last = state.pages[state.pages.length - 1].pageNumber;
  pageInput.min = first;
  pageInput.max = last;
  pageInput.disabled = false;
  prevPageBtn.disabled = false;
  nextPageBtn.disabled = false;
  scanCurrentPageBtn.disabled = false;
  totalPagesEl.textContent = last;
}

// Whenever the active page in Pane 3 changes — via ‹›, the page number
// input, or selecting a question — bring the matching "bond paper" sheet
// in Pane 2 smoothly into view.
function scrollDocTextToPage(pageNum) {
  const target = docTextContainer.querySelector(`.doc-page[data-page="${pageNum}"]`);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let renderTaskInFlight = null;

let pptxRenderGeneration = 0;


async function renderPptxSlide(pageNumber) {
  const myGen = ++pptxRenderGeneration;

  const pageData = state.pages.find(p => p.pageNumber === pageNumber);
  const fallbackText = pageData && pageData.text
    ? pageData.text
    : '(no extractable text on this slide)';

  const setVisible = (tier1On, tier2On, textOn) => {
    if (pptxTier1Container) pptxTier1Container.classList.toggle('hidden', !tier1On);
    if (pptxTier2Container) pptxTier2Container.classList.toggle('hidden', !tier2On);
    slideTextPreview.classList.toggle('hidden', !textOn);
    // Any tier resolving (including the final Tier 3 fallback below)
    // means loading is over — always clear it here rather than relying
    // on every call site to remember to.
    if (pptxLoadingState) pptxLoadingState.classList.add('hidden');
  };


  if (pptxLoadingState) pptxLoadingState.classList.remove('hidden');
  if (pptxTier1Container) pptxTier1Container.classList.add('hidden');
  if (pptxTier2Container) pptxTier2Container.classList.add('hidden');
  slideTextPreview.classList.add('hidden');

  // Tier 1 — real visual reconstruction. Text stays hidden; whatever
  // text was on the slide is already part of the rendered visual.
  try {
    const ok1 = await renderPptxTier1(pptxTier1Container, state.pptxFile, pageNumber);
    if (myGen !== pptxRenderGeneration) return;
    if (ok1) { setVisible(true, false, false); return; }
  } catch (e) {
    console.error('[doc-pane-navigation] pptx Tier 1 error:', e);
  }

  // Tier 2 — partial visual (embedded images only), shown alongside the
  // existing plain-text extraction per the handoff spec.
  try {
    const ok2 = await renderPptxTier2(pptxTier2Container, state.pptxZip, pageNumber);
    if (myGen !== pptxRenderGeneration) return;
    if (ok2) {
      slideTextPreview.textContent = fallbackText;
      setVisible(false, true, true);
      return;
    }
  } catch (e) {
    console.error('[doc-pane-navigation] pptx Tier 2 error:', e);
  }

  // Tier 3 — original plain-text fallback. Unchanged behavior.
  if (myGen !== pptxRenderGeneration) return;
  slideTextPreview.textContent = fallbackText;
  setVisible(false, false, true);
}

// Renders Pane 3 (the source PDF/slide) for a given page number.
// `opts.scrollText` (default true) also scrolls Pane 2 (the text
// version) to the matching "bond paper" sheet; pass `scrollText: false`
// when the call originated from Pane 2's own scroll.

function renderSourcePage(num, opts) {
  const scrollText = !opts || opts.scrollText !== false;
  if (state.pages.length === 0) return;
  const first = state.pages[0].pageNumber;
  const last = state.pages[state.pages.length - 1].pageNumber;

  if (num > last || num < first) {

    const activeIndex = state.sources.findIndex(s => s.id === state.activeSourceId);
    const targetIndex = num > last ? activeIndex + 1 : activeIndex - 1;
    const targetSource = state.sources[targetIndex];
    if (targetSource) {
      state.activeSourceId = targetSource.id;
      setupNavRange(); // refresh pageInput min/max/total for the new active source
      const entryPage = num > last
        ? (targetSource.pages[0] ? targetSource.pages[0].pageNumber : 1)
        : (targetSource.pages.length ? targetSource.pages[targetSource.pages.length - 1].pageNumber : 1);
      renderSourcePage(entryPage, opts);
      return;
    }
    // No next/previous source — fall through to the original clamp.
  }

  const clamped = Math.min(Math.max(first, num), last);
  state.currentPage = clamped;
  pageInput.value = clamped;
  updateSyncBadge(clamped);
  renderPane3QuestionNav();

  renderTermBar();
  if (scrollText) scrollDocTextToPage(clamped);


  if (state.docType !== 'pptx') {
    if (pptxTier1Container) pptxTier1Container.classList.add('hidden');
    if (pptxTier2Container) pptxTier2Container.classList.add('hidden');
    if (pptxLoadingState) pptxLoadingState.classList.add('hidden');
    teardownTier1Scaling();
  }

  if (state.docType === 'pdf' && state.pdfDoc) {
    state.pdfDoc.getPage(clamped).then((page) => {
      const containerWidth = pdfViewport.clientWidth - 48;
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.max(0.5, containerWidth / baseViewport.width);
      const viewport = page.getViewport({ scale });

      pdfCanvas.width = viewport.width;
      pdfCanvas.height = viewport.height;
      const ctx = pdfCanvas.getContext('2d');

      if (renderTaskInFlight) renderTaskInFlight.cancel();
      renderTaskInFlight = page.render({ canvasContext: ctx, viewport });
      renderTaskInFlight.promise.catch((err) => {
        if (err && err.name !== 'RenderingCancelledException') console.error(err);
      });
    });
  } else if (state.docType === 'pptx') {
    renderPptxSlide(clamped);
  }
}

// Back-compat name used throughout the rest of the file (‹›, the page
// number input, "jump to source", etc.) — always scrolls Pane 2 too.

function renderDocPage(num) {
  renderSourcePage(num, { scrollText: true });
}


function updateSyncBadge(pageNum) {
  if (state.activeCardId) {
    syncBadge.classList.remove('hidden');
    syncBadge.classList.add('flex');
    syncBadgeText.textContent = 'synced → p.' + pageNum;
  } else {
    syncBadge.classList.add('hidden');
    syncBadge.classList.remove('flex');
  }
}


prevPageBtn.addEventListener('click', () => renderDocPage(state.currentPage - 1));
nextPageBtn.addEventListener('click', () => renderDocPage(state.currentPage + 1));
pageInput.addEventListener('change', (e) => renderDocPage(parseInt(e.target.value, 10) || 1));

export {
  setupNavRange,
  scrollDocTextToPage,
  renderSourcePage,
  renderDocPage,
  updateSyncBadge,
};
