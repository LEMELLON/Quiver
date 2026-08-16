// pptx-render.js
// NEW MODULE (not extracted from the legacy monolith) — implements the
// 3-tier fallback visual renderer for Pane 3 on PPTX imports, per
// PPTX_RENDER_HANDOFF_PROMPT.md, with follow-up fixes from
// PPTX_RENDER_FOLLOWUP_PROMPT.md, and a LIBRARY SWAP (this round — see
// below) replacing Tier 1's rendering engine:
//   Tier 1 — real client-side visual reconstruction, via the third-party
//            @aiden0z/pptx-renderer library (npmjs.com/package/@aiden0z/pptx-renderer).
//   Tier 2 — embedded-image fallback: pulls the slide's own pictures
//            straight out of the already-loaded JSZip instance via the
//            slide's .rels file. No external library involved.
//   Tier 3 (plain text) is NOT implemented here — the existing path in
//            doc-pane-navigation.js is untouched and stays the final
//            fallback; this module only ever returns true/false so the
//            caller can fall through.
//
// Both tiers are exposed as async functions that resolve `true` on
// success (something was painted into `container`) or `false` on any
// failure/unavailability. Callers don't need their own try/catch —
// everything unexpected is caught and logged internally so one bad
// slide can't throw out of the fallback chain. The exported function
// signatures (`renderPptxTier1(container, file, pageNumber)`,
// `renderPptxTier2(container, zip, pageNumber)`) are UNCHANGED from
// before this round's swap, so doc-pane-navigation.js's call sites
// needed no edits.
//
// LIBRARY SWAP (this round): the previous Tier 1 engine, PPTXjs
// (meshesha/PPTXjs), turned out to have poor real-world fidelity —
// per its own README, "not Supports most of shapes, audio, video etc."
// — and its jQuery/JSZip-2.x iframe-isolation plumbing carried its own
// reload/reinsertion hazard (fixed last round, but the underlying
// fidelity problem remained). Replaced with @aiden0z/pptx-renderer
// (github.com/aiden0z/pptx-renderer, npm, Apache-2.0):
//   - Native OOXML parser + HTML/SVG renderer (187+ shapes, tables,
//     charts via ECharts, 134+ SmartArt layouts, the full OOXML color
//     pipeline) with 452+ automated visual-regression cases scored
//     against actual PowerPoint-exported ground truth — a real fidelity
//     bar PPTXjs never had.
//   - Bundles its own JSZip internally, so the whole namespace-isolated
//     iframe (previously needed solely to keep PPTXjs's bundled JSZip
//     2.x from clobbering this app's own JSZip 3.x global) is no longer
//     needed at all — removed below, not just patched.
//   - Ships `RECOMMENDED_ZIP_LIMITS`, explicit guidance to treat PPTX
//     input as untrusted, and protocol-filtered external links — a
//     better security posture for arbitrary user-uploaded files than
//     PPTXjs offered.
//   - Headless `renderSlide(presentation, slideData, opts)` renders one
//     slide into a freshly created, caller-owned DOM element (`handle
//     .element`) with its own `handle.ready` / `handle.dispose()`
//     lifecycle. Using this (rather than a shared, reused viewer
//     instance) means every render produces a brand-new node instead of
//     reusing/reinserting one across slides — the exact reload/
//     reinsertion failure mode fixed defensively last round in the old
//     iframe-based Tier 1 can't happen here by construction, since
//     there's no persistent element being moved around the DOM.
//
// Honest trade-off, stated plainly rather than glossed over: this
// library is young — public npm history of a few months, one visible
// maintainer, first tagged release this year — where PPTXjs at least
// had years of real usage behind its poor fidelity. It was chosen
// anyway because (a) its own test/security rigor (CI, codecov, 452+
// regression cases, documented ZIP-bomb limits) is unusually strong for
// a project this new, and (b) the fidelity gap for ordinary decks (the
// kind this app's users upload — text, images, basic layout) is large
// enough to matter now, not just in the abstract. Documented gaps: 3D
// effects/charts, animations/transitions, OMML equations, full EMF/WMF
// vector art, shadow/reflection/glow, embedded OLE objects, slide notes
// — none of which affect a typical text-and-picture deck.
//
// CDN LOADING: no local copy of this library exists in this no-bundler,
// plain-<script type="module">-served codebase, and the package doesn't
// publish a documented fixed browser-bundle filename to hardcode (unlike
// PPTXJS_BASE's known dist/ layout). Loaded instead via jsDelivr's
// documented `+esm` endpoint (https://cdn.jsdelivr.net/npm/<pkg>@<version>/+esm),
// which resolves any published npm package — CJS or ESM — into a
// working browser ES module with its own dependency graph included, and
// is what's actually `import()`-ed at runtime below. PINNED to 1.2.0
// (latest published version at the time of this change) rather than an
// unpinned/`@latest` specifier, same reasoning as the old PPTXJS_BASE
// version pin this replaces: an unpinned CDN reference means a future
// publish (or a compromised one) starts loading into every user's
// browser with no warning. Bump this deliberately, and re-verify,
// rather than ever pointing at an unpinned tag.
//
// NOT VERIFIED IN A RUNNING BROWSER: this file was written and
// syntax-checked (`node --check`) but not executed end-to-end against a
// live jsDelivr fetch or a real .pptx file — this environment has no
// network access or browser to do that in. The `+esm` endpoint and the
// package's exported API surface (`renderSlide`, `parseZip`,
// `buildPresentation`, `RECOMMENDED_ZIP_LIMITS`) are both taken directly
// from the library's own published README, not guessed, but please
// treat the very next real test run as the first actual verification of
// this integration, not a re-confirmation of something already proven.

// SIZING/SCALING FIX (this round — see PPTX_RENDER_TIER1_SIZING_FIX_PROMPT.md):
// confirmed the file-header's own "NOT VERIFIED IN A RUNNING BROWSER"
// caveat above was hiding a real bug. `handle.element` does carry fixed
// native pixel width/height derived from the deck's EMU slide size —
// its layout box stays at that native size no matter what container
// it's dropped into — and nothing in this library's headless
// `renderSlide(presentation, slideData, opts)` accepts a width/height/
// scale/fit option; `opts` only takes `onNodeError`, `mediaUrlCache`,
// and `pdfjs` (checked directly against the library's own published
// README/CHANGELOG, not assumed). That kind of fit-to-container scaling
// only exists on the higher-level `PptxViewer` *instance* methods
// (`renderSlideToContainer` / `renderThumbnailToContainer`) — this
// module deliberately doesn't use a `PptxViewer` instance (see file
// header above), so scaling is hand-rolled below instead: measure the
// rendered slide's native box, compute a scale factor against
// `#pptxTier1Container`'s actual available width, and apply it via CSS
// `transform`. See `setupTier1ResponsiveScaling()` for the ResizeObserver-
// based approach (also satisfies the "recompute on resize" requirement,
// since Pane 3 is user-resizable) and why it — rather than a one-shot
// measurement right after `appendChild` — is what actually works given
// `#pptxTier1Container` is still hidden (`display: none`) at that point
// in the render sequence (doc-pane-navigation.js's `setVisible()` only
// unhides it after this function has already resolved `true`).
const PPTX_RENDERER_CDN_URL = 'https://cdn.jsdelivr.net/npm/@aiden0z/pptx-renderer@1.2.0/+esm'; // pinned — see CDN LOADING above.

// Cached dynamic-import promise for the library module — fetched once,
// reused for every render. If the import itself fails (offline, CDN
// blocked, etc.) the cached rejection is cleared so a later call can
// retry rather than being permanently stuck on one transient failure.
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

// Cached parsed-presentation promise, keyed by File object identity —
// same spirit as the old Tier 1's `tier1RenderedFile` cache: avoids
// re-unzipping and re-parsing the whole deck's XML on every slide
// navigation within the same file, only redoing it when `file` actually
// changes (a new upload).
let cachedPresentation = null; // { file, presentationPromise }
function getPresentationForFile(file) {
  if (cachedPresentation && cachedPresentation.file === file) {
    return cachedPresentation.presentationPromise;
  }
  const presentationPromise = (async () => {
    const { parseZip, buildPresentation, RECOMMENDED_ZIP_LIMITS } = await loadPptxRendererModule();
    const buf = await file.arrayBuffer(); // File/Blob#arrayBuffer() is safely re-callable — not a stream, doesn't get consumed.
    // RECOMMENDED_ZIP_LIMITS — this library's own documented guard
    // against oversized/malicious ZIP entries. Applied here since
    // `file` is always a user-uploaded .pptx (see SECURITY note in the
    // library's own README: "Treat PPTX input as untrusted").
    const files = await parseZip(buf, RECOMMENDED_ZIP_LIMITS);
    return buildPresentation(files);
  })();
  cachedPresentation = { file, presentationPromise };
  return presentationPromise;
}

// Guards against a slow, superseded render (user navigated again before
// this one finished) clobbering a newer one — same spirit as the old
// Tier 1's `renderToken`, kept under the same name.
let renderToken = 0;

// The most recently rendered slide's handle, so it can be disposed
// (revoking its blob URLs / chart instances) before the next slide's
// handle replaces it in `container`. Not reused across renders — each
// call gets a fresh `handle.element` from the library's headless
// `renderSlide()`, which is what makes this immune to the old iframe-
// reuse reload bug (see LIBRARY SWAP note above).
let currentSlideHandle = null;

// ---------------------------------------------------------------------
// Tier 1 responsive scaling — see the SIZING/SCALING FIX note near the
// top of this file, and PPTX_RENDER_TIER1_SIZING_FIX_PROMPT.md, for why
// this exists and why it's a ResizeObserver rather than a one-shot
// measurement.
// ---------------------------------------------------------------------

// The observer for whichever slide is currently mounted in
// #pptxTier1Container, so it can be disconnected before the next one
// replaces it (or before this module gives up on Tier 1 for a slide and
// hands off to Tier 2/3) rather than left running against a detached
// element. Also exported (see bottom of file) — every renderPptxTier1()
// call tears down the PREVIOUS observer, but nothing tore down the LAST
// one if the user leaves PPTX entirely (imports a PDF and never opens
// another PPTX) — see PPTX_RENDER_TIER1_VERIFY_AND_TIER2_HIDDEN_FIX_PROMPT.md
// item 5. doc-pane-navigation.js calls this directly on that docType
// switch now.
let currentTier1ResizeObserver = null;

function teardownTier1Scaling() {
  if (currentTier1ResizeObserver) {
    currentTier1ResizeObserver.disconnect();
    currentTier1ResizeObserver = null;
  }
}

// `wrapper` is a plain div this module creates around `slideEl`
// (`handle.element`) — see renderPptxTier1's success path. Sizing THIS
// wrapper to the scaled box (rather than sizing `#pptxTier1Container`
// itself, or relying on its CSS) means the container's own
// `overflow: hidden` is a safety net, not the thing doing the fitting —
// there's no leftover blank space for it to need to clip in the first
// place, and no separate aspect-ratio CSS is needed since the wrapper's
// height is always derived from the slide's actual native aspect ratio.
function setupTier1ResponsiveScaling(container, wrapper, slideEl) {
  teardownTier1Scaling();

  slideEl.style.transformOrigin = 'top left';

  const applyScale = () => {
    // slideEl's own layout box. Unaffected by any `transform` we apply
    // below (transform changes paint, not layout size), so this stays
    // a stable read across every call, including ones triggered by our
    // own wrapper.style.height write further down.
    const nativeWidth = slideEl.offsetWidth;
    const nativeHeight = slideEl.offsetHeight;
    const availableWidth = container.clientWidth;
    if (!nativeWidth || !nativeHeight || !availableWidth) {
      // #pptxTier1Container (or slideEl itself) isn't laid out yet —
      // most commonly because it's still behind doc-pane-navigation.js's
      // `hidden` class at this point in the render sequence. Nothing to
      // do this tick; the observer fires again once that changes (e.g.
      // the moment setVisible() unhides the container), which is what
      // makes ResizeObserver the right tool here instead of a rAF-timed
      // guess.
      return;
    }
    const scale = availableWidth / nativeWidth;
    slideEl.style.transform = `scale(${scale})`;
    wrapper.style.width = `${availableWidth}px`;
    wrapper.style.height = `${Math.round(nativeHeight * scale)}px`;
  };

  currentTier1ResizeObserver = new ResizeObserver(applyScale);
  currentTier1ResizeObserver.observe(container);

  // VERIFICATION NOTE (PPTX_RENDER_TIER1_VERIFY_AND_TIER2_HIDDEN_FIX_PROMPT.md,
  // item 3): per the ResizeObserver spec, a target transitioning from
  // `display: none` (no box) to rendered with a real size is a bona fide
  // resize and delivers a fresh notification — which is what this whole
  // approach depends on, since `#pptxTier1Container` is still hidden when
  // `.observe()` above is called and only unhides right after this
  // function's caller returns. That's standard, broadly-relied-upon
  // browser behavior, but it was never exercised against a live browser
  // in THIS environment (no network/display here — see file header), so
  // rather than ship it on spec-reading alone, two redundant rAF-delayed
  // manual calls are added as a belt-and-suspenders fallback: if the
  // observer's automatic re-fire on unhide doesn't happen for some
  // reason, these still catch the container once it's actually visible.
  // Both are cheap no-ops (`applyScale` early-returns on a 0 size) if the
  // observer already handled it first. Safe to remove once someone
  // confirms in a real browser that the observer alone is sufficient.
  requestAnimationFrame(() => {
    requestAnimationFrame(applyScale);
  });
}

// ---------------------------------------------------------------------
// Tier 1 — real client-side visual reconstruction via @aiden0z/pptx-renderer.
// ---------------------------------------------------------------------
async function renderPptxTier1(container, file, pageNumber) {
  console.log(`[pptx-render] Tier 1: attempting slide ${pageNumber}`, { fileName: file && file.name });

  if (!container || !file) {
    console.log('[pptx-render] Tier 1: false — missing container or file', { hasContainer: !!container, hasFile: !!file });
    return false;
  }

  // Every call — success, failure, or superseded — starts by tearing
  // down whatever resize observer was watching the PREVIOUS slide's
  // wrapper, so a stale observer never keeps running against a detached
  // element once this call replaces (or fails to replace) it.
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
    // Wrap rather than append handle.element directly — see the
    // SIZING/SCALING FIX note near the top of this file. The wrapper
    // starts at zero height (clipped via overflow:hidden) so nothing
    // paints at handle.element's native, unscaled size for the one
    // frame before the ResizeObserver below computes the real scale.
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

// ---------------------------------------------------------------------
// Tier 2 — embedded-image fallback. Resolves this slide's own <p:pic>
// (and any other <a:blip>) picture references against its .rels file,
// pulls the raster bytes straight out of `zip` (state.pptxZip — the
// same JSZip instance extractPptxPages already loaded), and renders a
// simple stacked image preview. Not a full slide screenshot — just
// whatever pictures the slide actually embeds. UNCHANGED by this
// round's Tier 1 library swap: no external library involved here, and
// the iframe-parking workaround added last round is gone because
// there's no longer any iframe in this file to protect (see LIBRARY
// SWAP note at the top of this file) — a plain container clear is safe
// again now that Tier 1 never leaves a shared, reused node behind.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// UPDATE2_SLIDE_PANE_PROMPT.md: factored out of renderPptxTier2 (below)
// so the new source-stack thumbnail helper (getPptxThumbnailDataUrl,
// further down) can reuse the exact same <p:pic>/<a:blip> resolution
// logic instead of duplicating it. Pure extraction — the XML/rels
// parsing here is byte-for-byte what renderPptxTier2 always did
// inline. Returns the resolved Blobs (or null on any failure/no-
// pictures-found case) rather than touching the DOM at all; each
// caller decides what to do with them.
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Source-stack thumbnail (new — see UPDATE2_SLIDE_PANE_PROMPT.md,
// "Which renderer to reuse for the thumbnail"). DELIBERATELY reuses
// Tier 2's cheap embedded-image extraction (resolveSlideImageBlobs
// above) rather than Tier 1's full @aiden0z/pptx-renderer visual
// reconstruction — stated trade-off:
//   - Tier 1 (renderPptxTier1) is a full OOXML parse + shape/table/
//     chart/SmartArt render via an external CDN library, built to
//     serve Pane 3's ONE currently-viewed slide. Running that once per
//     imported source purely to produce a ~64px card thumbnail nobody
//     is actively looking at yet is a heavy way to answer "what's
//     roughly on this slide," and this runs at import time across a
//     whole batch of sources, not once for a single active view.
//   - Tier 2's approach (pull the slide's own embedded pictures
//     straight out of the already-in-memory JSZip, no external library,
//     no network) is nearly free per source and, at thumbnail scale, a
//     rough "here's a picture from this slide" preview reads fine even
//     though it isn't a full laid-out render.
//   - Honest cost of that choice: a text-only slide with no embedded
//     picture yields no thumbnail at all — the caller (main.js's
//     renderSourceList()) falls back to a plain text badge in that
//     case. Tier 1 could in principle still have produced a real visual
//     for a text-only slide. Judged an acceptable trade for keeping
//     import-time cost low across a whole batch, especially since nothing
//     stops a later pass from upgrading this to Tier 1 if that gap turns
//     out to matter in practice.
//
// Returns a PERSISTENT `data:` URL (via FileReader), not an object URL:
// Tier 2's own container render revokes its object URLs the instant
// each <img> loads, which is fine there (Pane 3's pixels are already
// painted by then) but wrong here — the caller caches this string on
// source.thumbnailDataUrl and reuses it across many later
// renderSourceList() redraws, so a revoked object URL would go stale
// (broken image) the moment the next redraw runs.
// ---------------------------------------------------------------------
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

export { renderPptxTier1, renderPptxTier2, teardownTier1Scaling, getPptxThumbnailDataUrl };