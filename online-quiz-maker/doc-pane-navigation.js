// doc-pane-navigation.js
// Extracted verbatim from online-quiz-maker.html (module [14] per
// MODULARIZATION_SCHEMA.txt): setupNavRange, scrollDocTextToPage,
// renderSourcePage, renderDocPage, updateSyncBadge. Function bodies were
// UNCHANGED from source at extraction time — see the NOTE block below
// for the one spot where module scoping is handled differently from the
// schema's "SHARED CONTEXT" listing (not a logic change), and see the
// PPTX TIER RENDERING note further down for the one place this file has
// since diverged from verbatim-extracted: renderSourcePage's `pptx`
// branch, updated per PPTX_RENDER_HANDOFF_PROMPT.md to try a 3-tier
// visual fallback instead of going straight to plain text, plus a
// FOLLOW-UP addition (Fix 4, PPTX_RENDER_FOLLOWUP_PROMPT.md) that shows
// a loading placeholder while the tiers are being attempted. The PDF
// branch and every other function here are still byte-for-byte what
// was extracted.
//
// SOURCE LINE RANGES (in original file order):
//   4500-4511  setupNavRange
//   4516-4519  scrollDocTextToPage
//   4528-4563  renderSourcePage (pptx branch since modified — see above)
//   4567-4569  renderDocPage
//   4571-4580  updateSyncBadge
//   4582-4584  prevPageBtn/nextPageBtn/pageInput listeners (moved with handler)
//
// NOTE (structural, not a logic change): MODULARIZATION_SCHEMA.txt's
// "SHARED CONTEXT" section lists `renderTaskInFlight` (source line 646)
// alongside `pendingSelection`/`lastDocSelection` as a loose state var
// that "lives in ONE place" and is imported by whichever modules need
// it. Unlike pendingSelection/lastDocSelection (which are read AND
// reassigned from two different modules — selection-toolbar.js and
// snippet-question-generation.js — and so needed a core-state.js
// getter/setter pair), renderTaskInFlight is read and reassigned only
// here, inside renderSourcePage, and nowhere else in the whole source
// file (verified: only source lines 4551-4553 touch it). Since ES
// modules only need a shared getter/setter when a `let` is reassigned
// from OUTSIDE its declaring module, keeping it as a plain module-level
// `let` declared directly in this file (its sole owner) satisfies
// "lives in ONE place" without adding needless getter/setter ceremony.
// Its initializer (`let renderTaskInFlight = null;`, source line 646)
// is reproduced verbatim below, immediately before its only use site.
//
// PPTX TIER RENDERING (new, not from source): renderSourcePage's `pptx`
// branch now delegates to renderPptxSlide() (defined in this file, new)
// which tries pptx-render.js's Tier 1 (real visual via a namespace-
// isolated PPTXjs iframe — see pptx-render.js for why "namespace-
// isolated," not "sandboxed") then Tier 2 (embedded-image extraction)
// before falling back to the original plain-text behavior as Tier 3 —
// that Tier 3 path is the exact code that used to be renderSourcePage's
// whole pptx branch, unchanged. A module-level `pptxRenderGeneration`
// counter guards against a slow, superseded tier render (e.g. user
// clicked next/prev again before Tier 1 finished) clobbering a newer
// one — same spirit as `renderTaskInFlight`'s cancellation for the PDF
// branch, just scoped to this file's own new code rather than pdf.js's
// own cancel() API.
//
// FOLLOW-UP Fix 4 (PPTX_RENDER_FOLLOWUP_PROMPT.md): renderPptxSlide()
// now shows `pptxLoadingState` the instant it starts, and clears it the
// moment any tier resolves — including the final Tier 3 fallback, so
// the loading placeholder never lingers once plain text is showing.
// Implemented here (rather than inside pptx-render.js) since it's pure
// Pane-3-visibility bookkeeping, the same category of thing `setVisible`
// already does.
//
// SLIDE_PANEL_MIRROR_REVERT_AND_THUMBNAIL_FIX_PROMPT.md: the
// SLIDE_PANEL_LIVE_MIRROR_PROMPT.md work that used to live here — a
// single `updateSlidePanelMirror(clamped)` call at the settled point
// inside renderSourcePage() — has been removed. That mirror was an
// unrequested second preview mechanism layered on top of the real slide
// panel (#sourceList's per-card thumbnails, main.js's
// ensureSourceThumbnail()); see the revert prompt for the full
// reasoning. Nothing else in this file changed for the revert —
// renderSourcePage's own cross-source rollover recursion, renderPptxSlide's
// tier-fallback chain, and the pdfCanvas/renderTaskInFlight pair below
// are all exactly as they were before the mirror ever existed.

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
import { renderPane3QuestionNav } from './editor-render.js';
import { renderPptxTier1, renderPptxTier2, teardownTier1Scaling } from './pptx-render.js';

// ---------------------------------------------------------------------
// Verbatim from source, lines 4500-4511
// ---------------------------------------------------------------------
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
// ---------------------------------------------------------------------
// Verbatim from source, lines 4516-4519
// ---------------------------------------------------------------------
function scrollDocTextToPage(pageNum) {
  const target = docTextContainer.querySelector(`.doc-page[data-page="${pageNum}"]`);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// source line 646 (see NOTE at top of file) — sole owner of this var.
let renderTaskInFlight = null;

// New (not from source) — guards the async 3-tier PPTX render chain so
// a slide render that's still in flight when the user navigates again
// can detect it's stale and bail before touching the DOM. See PPTX TIER
// RENDERING note at top of file.
let pptxRenderGeneration = 0;

// New (not from source) — tries Tier 1 (real visual), then Tier 2
// (embedded images, shown alongside the plain text), then falls back to
// Tier 3 (plain text only) — the exact behavior renderSourcePage's pptx
// branch used to have inline. See pptx-render.js for Tier 1/2. Shows/
// hides pptxLoadingState per FOLLOW-UP Fix 4 — see note at top of file.
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

  // FOLLOW-UP Fix 4 — loading feedback shown immediately, before any
  // tier is attempted, and hidden by setVisible() the moment one of
  // them resolves (success or final Tier 3 fallback).
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
// version) to the matching "bond paper" sheet — this is the
// source-drives-text direction of the two-way sync. Pass
// `scrollText: false` when the call originated from Pane 2's own
// scroll (see docTextViewport's scroll listener below) so we don't
// fight the scroll the user is already mid-way through.
// ---------------------------------------------------------------------
// Verbatim from source, lines 4528-4563, EXCEPT the pptx branch — see
// PPTX TIER RENDERING note at top of file — AND the boundary-clamping
// line, now cross-source rollover — see UPDATE 2A note below. The pdf
// branch below is untouched.
// ---------------------------------------------------------------------
// UPDATE 2A: with multiple imported sources, running past the last page
// of the active source (via next/prev-page navigation, or typing a page
// number out of range) now rolls over into the next/previous source in
// state.sources order — like a merged PDF viewer — instead of clamping
// at that source's own boundary. Implemented as a small recursive
// hand-off: switch state.activeSourceId (which, via core-state.js's
// shim, makes state.pages/docType/pdfDoc/pptxFile/pptxZip instantly
// resolve to the NEW active source), refresh the nav-range bounds for
// that source, then re-run this function against it. Falls through to
// the original clamp-at-the-boundary behavior when there's no
// next/previous source (single-source case — today's exact behavior).
// ---------------------------------------------------------------------
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
  if (scrollText) scrollDocTextToPage(clamped);

  // New (not from source): the pptx Tier 1/2/loading containers are
  // only ever relevant while viewing a pptx; keep them out of the way
  // otherwise so switching back to a PDF doesn't leave a stale slide
  // visual (or loading placeholder) sitting in Pane 3. Doesn't touch
  // the pdf branch itself.
  //
  // Also tears down pptx-render.js's Tier 1 ResizeObserver here (not
  // just left for the next renderPptxTier1() call to clean up) — per
  // PPTX_RENDER_TIER1_VERIFY_AND_TIER2_HIDDEN_FIX_PROMPT.md item 5,
  // without this a user who imports a PPTX, then a PDF, and never opens
  // another PPTX in the session leaves that observer attached to a
  // hidden-but-still-in-DOM container for the rest of the session.
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
// ---------------------------------------------------------------------
// Verbatim from source, lines 4567-4569
// ---------------------------------------------------------------------
function renderDocPage(num) {
  renderSourcePage(num, { scrollText: true });
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 4571-4580
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Verbatim from source, lines 4582-4584 (event wiring for this module's
// own renderDocPage — moved with handler per the schema's strategy)
// ---------------------------------------------------------------------
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
