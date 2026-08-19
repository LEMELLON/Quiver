// pdf-render.js
// Shared helper — renders one page of a loaded pdf.js pdfDoc to a canvas and returns a PNG data URL.
// No internal try/catch: callers own their own error/cancellation handling.
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
  // opts.onRenderTask, if given, lets the caller capture the render task to cancel it later.
  if (opts && typeof opts.onRenderTask === 'function') opts.onRenderTask(renderTask);
  await renderTask.promise;
  return canvas.toDataURL('image/png');
}

export { renderPdfPageToDataUrl };
