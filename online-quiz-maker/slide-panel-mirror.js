// slide-panel-mirror.js
// NEW MODULE (SLIDE_PANEL_LIVE_MIRROR_PROMPT.md): the live preview at
// the top of #sourcePane, above #sourceStackArea, that mirrors whatever
// page/slide Pane 3 is currently showing (state.currentPage for
// state.activeSourceId) — distinct from #sourceList's small, STATIC,
// first-page-only per-card thumbnails (main.js's ensureSourceThumbnail),
// which never update after import.
//
// Deliberately its own module rather than folded into
// doc-pane-navigation.js:
//   - keeps that file's own hard constraint trivially checkable ("don't
//     touch renderSourcePage's cross-source rollover mechanics... this
//     hooks onto the RESULT of that pipeline, it doesn't change how
//     Pane 3 itself resolves or renders") — its only change for this
//     prompt is a single call to updateSlidePanelMirror() at the
//     settled point in renderSourcePage(), everything else lives here.
//   - this module needs its OWN generation counter and its OWN PDF
//     render-task-in-flight, explicitly SEPARATE from
//     doc-pane-navigation.js's `pptxRenderGeneration` / PDF
//     `renderTaskInFlight` (that file's own PDF-render-task-
//     cancellation hard constraint) — a separate file makes "separate,
//     not shared" structurally obvious, not just a comment.
//
// HOOK POINT: called once per SETTLED renderSourcePage() resolution
// (see the single call site added in doc-pane-navigation.js), i.e.
// after any cross-source rollover recursion has already finished
// picking the final (source, page) pair — never from inside the
// recursive branch itself. This module doesn't re-derive that
// resolution; it just reads state.activeSourceId / getActiveSource()
// at the moment it's called, which by then already reflects whichever
// source renderSourcePage() actually settled on.

import { state, getActiveSource } from './core-state.js';
import {
  slidePanelMirrorEl,
  slidePanelMirrorImg,
  slidePanelMirrorEmpty,
  slidePanelMirrorFallback,
} from './dom-refs.js';
import { renderPdfPageToDataUrl } from './pdf-render.js';
import { getPptxThumbnailDataUrl } from './pptx-render.js';

// STALE-RENDER GUARD: incremented on every mirror update request. Any
// in-flight async work (PDF page.render(), or the PPTX
// getPptxThumbnailDataUrl -> zip.file(...).async('string') chain) checks
// its own captured generation number against the current one before
// touching the DOM, and bails silently if superseded — same pattern as
// doc-pane-navigation.js's pptxRenderGeneration, kept in its own counter
// per that file's "separate, not shared" note above.
let mirrorGeneration = 0;

// This mirror's OWN in-flight pdf.js render task — separate from
// doc-pane-navigation.js's renderTaskInFlight, which owns #pdfCanvas.
// This one owns its own off-screen canvas (inside renderPdfPageToDataUrl,
// see pdf-render.js) — both can legitimately be rendering concurrently
// for the same page, against the same pdfDoc, into two different
// canvases. Cancelled the same way doc-pane-navigation.js cancels its
// own: call .cancel() on the previous task before starting a new one,
// swallow the resulting RenderingCancelledException.
let mirrorPdfRenderTaskInFlight = null;

// DEBOUNCE DECISION (see prompt's "Debounce during rapid navigation"):
// added, at 120ms — matching selection-toolbar.js's existing
// docTextScrollSyncTimer convention for the same "don't fire on every
// intermediate event" need. The generation-counter guard above is
// CORRECT on its own (a superseded render's result is always dropped,
// never mis-shown against the wrong page) but isn't sufficient for good
// navigation feel BY ITSELF: without a debounce, holding next/prev (or
// typing a page number quickly) would still kick off a full pdf.js
// page.render() or PPTX zip re-read PER intermediate page, with all but
// the last one immediately discarded — real decode/render work wasted
// on every step instead of one render for wherever the user actually
// stops. Debouncing the WORK, not just discarding stale RESULTS, is the
// cheaper behavior, so both are used together here.
const MIRROR_DEBOUNCE_MS = 120;
let mirrorDebounceTimer = null;

// SIZING DECISION (see prompt's "Sizing"): rendered at 320px target
// width — noticeably larger than #sourceList's 64px card thumbnails
// (styles.css's .source-stack-thumb), close to the narrow #sourcePane
// column's own usable width (minmax(220px, 0.8fr), per
// UPDATE2_SLIDE_PANE_PROMPT.md) without being rendered at full native
// PDF resolution for what's ultimately a small preview box. The
// wrapper's CSS (styles.css, #slidePanelMirror) fixes a 16:9 box and
// lets the <img> itself use object-fit: contain, so a portrait PDF page
// letterboxes inside it rather than distorting — same "one box, several
// native aspect ratios" tradeoff the app already accepts for Pane 3's
// pptx Tier 1 container.
const MIRROR_TARGET_WIDTH = 320;

// Four mutually-exclusive states. 'empty' = nothing imported (or no
// active source resolved yet); 'loading' = a render is in flight;
// 'image' = a real preview is showing; 'fallback' = render failed, or
// there was nothing to render (e.g. a text-only pptx slide with no
// embedded picture — same honest gap main.js's static thumbnails
// already accept via source.thumbnailFailed / .source-stack-thumb-
// fallback). Reuses that existing fallback-badge CONVENTION (a plain
// state instead of an image) rather than inventing a new one, per the
// prompt's "Loading/failure state" design-decision ask.
function setMirrorState(mode) {
  if (!slidePanelMirrorImg) return; // dom-refs.js ref missing — no-op rather than throw
  slidePanelMirrorImg.classList.toggle('hidden', mode !== 'image');
  if (slidePanelMirrorEmpty) slidePanelMirrorEmpty.classList.toggle('hidden', mode !== 'empty');
  if (slidePanelMirrorFallback) slidePanelMirrorFallback.classList.toggle('hidden', mode !== 'fallback');
  // Loading pulse — see styles.css's .slide-panel-mirror-loading, same
  // spinner convention as .source-stack-thumb-loading, just toggled on
  // the wrapper (rather than the not-yet-populated <img>) since all
  // three state elements are hidden while loading.
  if (slidePanelMirrorEl) slidePanelMirrorEl.classList.toggle('slide-panel-mirror-loading', mode === 'loading');
}

// Public entry point — see the HOOK POINT note at the top of this file
// for where this is called from. `pageNumber` is the final, clamped
// page doc-pane-navigation.js is about to show in Pane 3.
function updateSlidePanelMirror(pageNumber) {
  if (mirrorDebounceTimer) clearTimeout(mirrorDebounceTimer);
  mirrorDebounceTimer = setTimeout(() => {
    mirrorDebounceTimer = null;
    runMirrorRender(pageNumber);
  }, MIRROR_DEBOUNCE_MS);
}

async function runMirrorRender(pageNumber) {
  const myGen = ++mirrorGeneration;

  // EMPTY/NO-SOURCE STATE (prompt's "Empty/no-source state"): nothing
  // imported at all. In practice, renderSourcePage() itself early-
  // returns before ever reaching this module's call site when
  // state.pages.length === 0 (see doc-pane-navigation.js), so this
  // branch won't currently fire mid-session — but online-quiz-maker.html
  // already renders the empty state as the default, un-JS'd markup (see
  // that file), so page load needs no JS call to already be correct.
  // This check stays as a defensive guard for any future call site
  // (e.g. a "remove source" action, which doesn't exist yet) that could
  // legitimately bring state.sources back to zero.
  if (state.sources.length === 0) {
    setMirrorState('empty');
    return;
  }

  // WRONG-SOURCE-CONTAMINATION GUARD: capture the resolved source
  // object directly, and read source.pdfDoc/source.pptxZip off of IT
  // below (never state's SHIMMED_SOURCE_KEYS, which always reflects
  // whichever source is active AT THE MOMENT THEY'RE READ, not
  // necessarily this render's source once its own async work resolves)
  // — same convention main.js's generatePdfThumbnail/
  // generatePptxThumbnail already use for the static per-card
  // thumbnails. Also capture sourceId, re-verified against
  // state.activeSourceId (alongside myGen) after every async step, per
  // the prompt's explicitly-offered equivalent approach.
  const source = getActiveSource();
  if (!source) {
    setMirrorState('empty');
    return;
  }
  const sourceId = source.id;

  setMirrorState('loading');

  if (source.docType === 'pdf') {
    // PDF RENDER-TASK CANCELLATION: this mirror's own in-flight task,
    // separate from doc-pane-navigation.js's — see file header.
    if (mirrorPdfRenderTaskInFlight) mirrorPdfRenderTaskInFlight.cancel();
    try {
      const dataUrl = await renderPdfPageToDataUrl(source.pdfDoc, pageNumber, MIRROR_TARGET_WIDTH, {
        onRenderTask: (task) => { mirrorPdfRenderTaskInFlight = task; },
      });
      mirrorPdfRenderTaskInFlight = null;
      if (myGen !== mirrorGeneration) return; // superseded — a newer navigation already started
      if (state.activeSourceId !== sourceId) return; // active source changed mid-flight
      if (dataUrl) {
        slidePanelMirrorImg.src = dataUrl;
        setMirrorState('image');
      } else {
        setMirrorState('fallback'); // no pdfDoc at the moment of the call
      }
    } catch (e) {
      mirrorPdfRenderTaskInFlight = null;
      if (e && e.name === 'RenderingCancelledException') return; // expected — a newer mirror render cancelled this one; silent no-op per the prompt's "same swallowing pattern as the existing code"
      console.error('[slide-panel-mirror] PDF render failed:', e);
      if (myGen === mirrorGeneration && state.activeSourceId === sourceId) setMirrorState('fallback');
    }
  } else if (source.docType === 'pptx') {
    // PPTX TIER DECISION (see prompt's "PPTX tier for the mirror"):
    // Tier 2 ONLY, via the existing getPptxThumbnailDataUrl(zip,
    // pageNumber) — the same call the static per-card thumbnail uses,
    // just with the CURRENT page instead of always page 1. No changes
    // needed in pptx-render.js; it already takes an arbitrary page
    // number. Deliberately NOT Tier 1 (renderPptxTier1): Tier 1 is a
    // full OOXML parse + shape/table/chart/SmartArt render through an
    // external CDN library (@aiden0z/pptx-renderer), built to serve
    // Pane 3's ONE actively-viewed slide. Re-running that a SECOND time
    // on every navigation, purely to also paint this secondary mirror
    // preview, would roughly double Tier 1's render cost per navigation
    // for a value that's explicitly "at a glance," not the primary
    // view — a much hotter path than the once-per-source-at-import-time
    // case the static thumbnail's own Tier 2-only reasoning already
    // applies to. Tier 2 is near-free (reads bytes already sitting in
    // the in-memory JSZip, no external library, no network) and, same
    // honest gap the static thumbnails already accept, simply produces
    // nothing (-> fallback badge) for a text-only slide with no
    // embedded picture.
    try {
      const dataUrl = await getPptxThumbnailDataUrl(source.pptxZip, pageNumber);
      if (myGen !== mirrorGeneration) return;
      if (state.activeSourceId !== sourceId) return;
      if (dataUrl) {
        slidePanelMirrorImg.src = dataUrl;
        setMirrorState('image');
      } else {
        setMirrorState('fallback');
      }
    } catch (e) {
      console.error('[slide-panel-mirror] PPTX render failed:', e);
      if (myGen === mirrorGeneration && state.activeSourceId === sourceId) setMirrorState('fallback');
    }
  } else {
    // No recognized docType for the resolved source (shouldn't normally
    // happen once a source is active) — treat like empty rather than
    // risk showing a stale/wrong image.
    setMirrorState('empty');
  }
}

export { updateSlidePanelMirror };
