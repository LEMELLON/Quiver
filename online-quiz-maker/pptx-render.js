// pptx-render.js
// 3-tier fallback visual renderer for Pane 3 on PPTX imports: Tier 1 real client-side render via
// @aiden0z/pptx-renderer, Tier 2 embedded-image fallback via JSZip, Tier 3 (plain text) lives in
// doc-pane-navigation.js. Also provides source-stack thumbnail generation (Tier 1 then Tier 2 fallback).

// pptx-renderer CDN module, pinned to 1.2.0.
const PPTX_RENDERER_CDN_URL = 'https://cdn.jsdelivr.net/npm/@aiden0z/pptx-renderer@1.2.0/+esm';

// Cached dynamic-import promise for the pptx-renderer module; cleared on failure so a later call can retry.
let pptxRendererModulePromise = null;
function loadPptxRendererModule() {
  if (!pptxRendererModulePromise) {
    pptxRendererModulePromise = import(/* webpackIgnore: true */ PPTX_RENDERER_CDN_URL).catch((e) => {
      pptxRendererModulePromise = null;
      throw e;
    });
  }
  return pptxRendererModulePromise;
}

// Cached parsed-presentation promise, keyed by File object identity, to avoid re-parsing the same deck.
let cachedPresentation = null; // { file, presentationPromise }
function getPresentationForFile(file) {
  if (cachedPresentation && cachedPresentation.file === file) {
    return cachedPresentation.presentationPromise;
  }
  const presentationPromise = (async () => {
    const { parseZip, buildPresentation, RECOMMENDED_ZIP_LIMITS } = await loadPptxRendererModule();
    const buf = await file.arrayBuffer(); // File/Blob#arrayBuffer() is safely re-callable — not a stream, doesn't get consumed.
    const files = await parseZip(buf, RECOMMENDED_ZIP_LIMITS);
    return buildPresentation(files);
  })();
  cachedPresentation = { file, presentationPromise };
  return presentationPromise;
}

// Guards against a slow, superseded render clobbering a newer one.
let renderToken = 0;

// The most recently rendered slide's handle, disposed before the next slide's handle replaces it.
let currentSlideHandle = null;

// The ResizeObserver for whichever slide is currently mounted in #pptxTier1Container, plus the container it's watching.
let currentTier1ResizeObserver = null;
let currentTier1Container = null;

function teardownTier1Scaling() {
  if (currentTier1ResizeObserver) {
    currentTier1ResizeObserver.disconnect();
    currentTier1ResizeObserver = null;
  }
  currentTier1Container = null;
}

// Stops the observer from firing without discarding it or the rendered slide.
function pauseTier1Scaling() {
  if (currentTier1ResizeObserver) {
    currentTier1ResizeObserver.disconnect();
  }
}

// Resumes an observer previously paused via pauseTier1Scaling(), re-observing the same container and
// recalculating its scale against the container's current size.
function resumeTier1Scaling() {
  if (currentTier1ResizeObserver && currentTier1Container) {
    currentTier1ResizeObserver.observe(currentTier1Container);
  }
}

// Measures the rendered slide's native box and scales it to fit the container via CSS transform,
// recomputing on resize since Pane 3 is user-resizable.
function setupTier1ResponsiveScaling(container, wrapper, slideEl) {
  teardownTier1Scaling();

  slideEl.style.transformOrigin = 'top left';

  const applyScale = () => {
    const nativeWidth = slideEl.offsetWidth;
    const nativeHeight = slideEl.offsetHeight;
    const availableWidth = container.clientWidth;
    if (!nativeWidth || !nativeHeight || !availableWidth) {
      // Container not laid out yet (e.g. still hidden) — observer fires again once that changes.
      return;
    }
    const scale = availableWidth / nativeWidth;
    slideEl.style.transform = `scale(${scale})`;
    wrapper.style.width = `${availableWidth}px`;
    wrapper.style.height = `${Math.round(nativeHeight * scale)}px`;
  };

  currentTier1Container = container;
  currentTier1ResizeObserver = new ResizeObserver(applyScale); // tracks the container so pause/resume can re-observe it
  currentTier1ResizeObserver.observe(container);

  // Belt-and-suspenders fallback in case the observer's auto re-fire on unhide doesn't happen; cheap no-op otherwise.
  requestAnimationFrame(() => {
    requestAnimationFrame(applyScale);
  });
}

// Tier 1 — real client-side visual reconstruction via @aiden0z/pptx-renderer. Resolves true on success, false on any failure/supersession.
async function renderPptxTier1(container, file, pageNumber) {
  console.log(`[pptx-render] Tier 1: attempting slide ${pageNumber}`, { fileName: file && file.name });

  if (!container || !file) {
    console.log('[pptx-render] Tier 1: false — missing container or file', { hasContainer: !!container, hasFile: !!file });
    return false;
  }

  teardownTier1Scaling();

  const myToken = ++renderToken;

  let renderSlideFn, presentation;
  try {
    const mod = await loadPptxRendererModule();
    renderSlideFn = mod.renderSlide;
    presentation = await getPresentationForFile(file);
  } catch (e) {
    console.error('[pptx-render] Tier 1 library load/parse failed:', e);
    return false;
  }
  if (myToken !== renderToken) {
    console.log('[pptx-render] Tier 1: false — superseded by a newer call while loading/parsing');
    return false;
  }

  const index = pageNumber - 1;
  const slideData = presentation.slides[index];
  if (!slideData) {
    console.log(`[pptx-render] Tier 1: false — no slide at index ${index} (deck has ${presentation.slides.length} slide(s))`);
    return false;
  }

  try {
    const handle = renderSlideFn(presentation, slideData, {
      onNodeError: (nodeId, err) => console.warn('[pptx-render] Tier 1 node render error:', nodeId, err),
    });
    await handle.ready; // awaits async media (e.g. EMF-PDF fallback previews) before we treat this as done
    if (myToken !== renderToken) {
      handle.dispose(); // discard rather than show a stale slide once a newer call has already started
      console.log('[pptx-render] Tier 1: false — superseded by a newer call while rendering');
      return false;
    }
    if (currentSlideHandle) currentSlideHandle.dispose();
    currentSlideHandle = handle;

    container.innerHTML = '';
    // Wrapper starts at zero height (clipped) so nothing paints at native size before scaling is computed.
    const wrapper = document.createElement('div');
    wrapper.className = 'pptx-tier1-slide-wrapper';
    wrapper.style.width = '100%';
    wrapper.style.height = '0';
    wrapper.style.overflow = 'hidden';
    wrapper.appendChild(handle.element);
    container.appendChild(wrapper);
    setupTier1ResponsiveScaling(container, wrapper, handle.element);
    console.log(`[pptx-render] Tier 1: true — slide ${pageNumber} rendered (${presentation.slides.length} slide(s) in deck)`);
    return true;
  } catch (e) {
    console.error('[pptx-render] Tier 1 render failed:', e);
    return false;
  }
}

// Resolves a slide's embedded picture blobs via its .rels file, for Tier 2 rendering and thumbnails.
async function resolveSlideImageBlobs(zip, pageNumber) {
  if (!zip) return null;
  const slidePath = `ppt/slides/slide${pageNumber}.xml`;
  const relsPath = `ppt/slides/_rels/slide${pageNumber}.xml.rels`;
  const slideFile = zip.file(slidePath);
  const relsFile = zip.file(relsPath);
  if (!slideFile || !relsFile) {
    console.log(`[pptx-render] resolveSlideImageBlobs: false — ${slidePath} or its .rels file not found in the zip`, { hasSlideFile: !!slideFile, hasRelsFile: !!relsFile });
    return null;
  }

  const [slideXml, relsXml] = await Promise.all([
    slideFile.async('string'),
    relsFile.async('string'),
  ]);

  const parser = new DOMParser();
  const slideDoc = parser.parseFromString(slideXml, 'application/xml');
  const relsDoc = parser.parseFromString(relsXml, 'application/xml');

  // rId -> media target, from the slide's own .rels file.
  const relTargets = {};
  const relNodes = relsDoc.getElementsByTagName('Relationship');
  for (let i = 0; i < relNodes.length; i++) {
    const id = relNodes[i].getAttribute('Id');
    const target = relNodes[i].getAttribute('Target');
    if (id && target) relTargets[id] = target;
  }

  const blipNodes = slideDoc.getElementsByTagName('a:blip');
  const mediaPaths = [];
  for (let i = 0; i < blipNodes.length; i++) {
    const rId = blipNodes[i].getAttribute('r:embed');
    const target = rId && relTargets[rId];
    if (!target) continue;
    // Targets are relative to ppt/slides/, e.g. "../media/image1.png".
    const resolved = new URL(target, 'https://pptx.local/ppt/slides/').pathname.replace(/^\//, '');
    mediaPaths.push(resolved);
  }
  if (mediaPaths.length === 0) {
    console.log(`[pptx-render] resolveSlideImageBlobs: false — no <a:blip r:embed> picture references found on slide ${pageNumber}`, { blipNodeCount: blipNodes.length });
    return null;
  }

  const blobs = await Promise.all(
    mediaPaths.map(async (path) => {
      const entry = zip.file(path);
      if (!entry) return null;
      try { return await entry.async('blob'); } catch { return null; }
    })
  );
  const validBlobs = blobs.filter(Boolean);
  if (validBlobs.length === 0) {
    console.log(`[pptx-render] resolveSlideImageBlobs: false — found ${mediaPaths.length} media reference(s) but none resolved to a blob`, { mediaPaths });
    return null;
  }
  return validBlobs;
}

// Tier 2 — renders a slide's own embedded pictures as a stacked image preview (not a full slide screenshot).
async function renderPptxTier2(container, zip, pageNumber) {
  console.log(`[pptx-render] Tier 2: attempting slide ${pageNumber}`);

  if (!container || !zip) {
    console.log('[pptx-render] Tier 2: false — missing container or zip', { hasContainer: !!container, hasZip: !!zip });
    return false;
  }
  try {
    const validBlobs = await resolveSlideImageBlobs(zip, pageNumber);
    if (!validBlobs) return false; // resolveSlideImageBlobs already logged the specific reason

    container.innerHTML = '';
    validBlobs.forEach((blob) => {
      const img = document.createElement('img');
      img.className = 'pptx-tier2-image';
      img.alt = `Embedded image, slide ${pageNumber}`;
      img.src = URL.createObjectURL(blob);
      img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
      container.appendChild(img);
    });
    console.log(`[pptx-render] Tier 2: true — slide ${pageNumber} rendered ${validBlobs.length} embedded image(s)`);
    return true;
  } catch (e) {
    console.error('[pptx-render] Tier 2 render failed:', e);
    return false;
  }
}

// Source-stack thumbnail, Tier 1 attempt: renders a slide once at import time into a detached,
// fixed-size wrapper sized to targetWidth. Returns null if Tier 1 can't produce anything for this slide.
async function renderPptxTier1Thumbnail(file, pageNumber, targetWidth) {
  if (!file) return null;

  let renderSlideFn, presentation;
  try {
    const mod = await loadPptxRendererModule();
    renderSlideFn = mod.renderSlide;
    presentation = await getPresentationForFile(file);
  } catch (e) {
    console.error('[pptx-render] Tier 1 thumbnail: library load/parse failed:', e);
    return null;
  }

  const index = pageNumber - 1;
  const slideData = presentation.slides[index];
  if (!slideData) {
    console.log(`[pptx-render] Tier 1 thumbnail: no slide at index ${index} (deck has ${presentation.slides.length} slide(s))`);
    return null;
  }

  let handle;
  try {
    handle = renderSlideFn(presentation, slideData, {
      onNodeError: (nodeId, err) => console.warn('[pptx-render] Tier 1 thumbnail node render error:', nodeId, err),
    });
    await handle.ready;
  } catch (e) {
    console.error('[pptx-render] Tier 1 thumbnail render failed:', e);
    return null;
  }

  const slideEl = handle.element;
  slideEl.style.transformOrigin = 'top left';

  // Measured off-screen (not display:none, which would report zero size) since offsetWidth/Height need real layout.
  const host = getThumbnailMeasureHost();
  host.appendChild(slideEl);
  const nativeWidth = slideEl.offsetWidth;
  const nativeHeight = slideEl.offsetHeight;
  host.removeChild(slideEl);

  if (!nativeWidth || !nativeHeight) {
    handle.dispose();
    console.log('[pptx-render] Tier 1 thumbnail: false — slide element measured zero size');
    return null;
  }

  const scale = targetWidth / nativeWidth;
  const wrapper = document.createElement('div');
  wrapper.className = 'source-stack-thumb-tier1-wrapper';
  wrapper.style.width = `${targetWidth}px`;
  wrapper.style.height = `${Math.round(nativeHeight * scale)}px`;
  wrapper.style.overflow = 'hidden';
  slideEl.style.transform = `scale(${scale})`;
  wrapper.appendChild(slideEl);

  // Not disposed here — this wrapper/handle is cached and reused as the persistent thumbnail (see main.js).
  console.log(`[pptx-render] Tier 1 thumbnail: true — slide ${pageNumber} rendered at ${targetWidth}px wide`);
  return wrapper;
}

// Shared, permanently off-screen host used only to give a not-yet-mounted slide element real layout for measurement.
let thumbnailMeasureHost = null;
function getThumbnailMeasureHost() {
  if (!thumbnailMeasureHost) {
    thumbnailMeasureHost = document.createElement('div');
    thumbnailMeasureHost.style.position = 'fixed';
    thumbnailMeasureHost.style.left = '-9999px';
    thumbnailMeasureHost.style.top = '-9999px';
    thumbnailMeasureHost.style.visibility = 'hidden';
    thumbnailMeasureHost.setAttribute('aria-hidden', 'true');
    document.body.appendChild(thumbnailMeasureHost);
  }
  return thumbnailMeasureHost;
}

// Source-stack thumbnail, Tier 2 fallback: reads the slide's first embedded picture as a persistent data: URL.
async function getPptxThumbnailDataUrl(zip, pageNumber) {
  try {
    const validBlobs = await resolveSlideImageBlobs(zip, pageNumber);
    if (!validBlobs) return null;
    const blob = validBlobs[0]; // first embedded picture only — a thumbnail card has no room for Tier 2's stacked multi-image gallery
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.error('[pptx-render] thumbnail generation failed:', e);
    return null;
  }
}

export { renderPptxTier1, renderPptxTier2, teardownTier1Scaling, pauseTier1Scaling, resumeTier1Scaling, renderPptxTier1Thumbnail, getPptxThumbnailDataUrl };
