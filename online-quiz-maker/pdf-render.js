// pdf-render.js
// NEW MODULE (SLIDE_PANEL_LIVE_MIRROR_PROMPT.md): a single shared helper
// that renders an arbitrary page of an already-loaded pdf.js `pdfDoc` to
// a small canvas and returns a PNG data URL. Factored out of main.js's
// generatePdfThumbnail() — which used to inline this exact canvas/
// viewport setup, hardcoded to `source.pages[0]` — so this new module's
// live Pane-3 mirror (slide-panel-mirror.js) can render an arbitrary
// CURRENT page the same way, without a third copy of the same pdf.js
// boilerplate. generatePdfThumbnail() now calls this helper too (see
// main.js) — same inputs, same output, no behavior change for that
// existing caller; only the canvas/viewport code itself moved.
//
// Why a standalone file rather than living in main.js (generatePdfThumbnail's
// original home) or doc-pane-navigation.js (the mirror's trigger point):
// main.js already imports `setupNavRange`/`renderDocPage` FROM
// doc-pane-navigation.js, so doc-pane-navigation.js (and anything it
// imports, like slide-panel-mirror.js) importing back from main.js would
// be a circular import. A standalone module — same pattern this codebase
// already uses for pptx-render.js — is the only place both the
// thumbnail generator (main.js) and the live mirror (slide-panel-
// mirror.js, imported by doc-pane-navigation.js) can reach without
// restructuring that existing import direction, which is out of this
// prompt's scope.
//
// DELIBERATELY NO internal try/catch and NO generation/cancellation
// bookkeeping here — that's caller policy, not this helper's job:
//   - main.js's generatePdfThumbnail() wraps its own try/catch around
//     the call (unchanged from before) and has no cancellation concept
//     at all — it's a one-time-per-source render at import time.
//   - slide-panel-mirror.js's mirror render needs to tell a genuinely
//     FAILED render apart from a CANCELLED one (a superseded in-flight
//     render, cancelled because the user navigated again) so it can
//     show a fallback badge for the former but silently no-op the
//     latter — see that file for its own try/catch around this call.
// A single swallow-everything try/catch in here couldn't serve both
// policies at once.
//
// `opts.onRenderTask(renderTask)`, if given, is invoked synchronously
// right after `page.render()` starts (before this function's own
// `await`) — so a caller that needs to CANCEL an in-flight render
// (see slide-panel-mirror.js's own renderTaskInFlight-equivalent,
// intentionally separate from doc-pane-navigation.js's) can capture the
// pdf.js render task immediately, rather than only after this whole
// async function resolves (by which point it's too late to cancel).
// main.js's generatePdfThumbnail() doesn't pass this — it never needs
// to cancel a thumbnail render.
async function renderPdfPageToDataUrl(pdfDoc, pageNumber, targetWidth, opts) {
  if (!pdfDoc) return null;

  const page = await pdfDoc.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = targetWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');

  const renderTask = page.render({ canvasContext: ctx, viewport });
  if (opts && typeof opts.onRenderTask === 'function') opts.onRenderTask(renderTask);
  // May throw RenderingCancelledException if a caller cancels renderTask
  // (via the task handed to onRenderTask above) before this resolves —
  // intentionally left uncaught here; see the file-header note on why
  // each caller owns its own try/catch instead of one shared here.
  await renderTask.promise;
  return canvas.toDataURL('image/png');
}

export { renderPdfPageToDataUrl };
