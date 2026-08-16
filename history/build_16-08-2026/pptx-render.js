// pptx-render.js
// NEW MODULE (not extracted from the legacy monolith) — implements the
// 3-tier fallback visual renderer for Pane 3 on PPTX imports, per
// PPTX_RENDER_HANDOFF_PROMPT.md, with follow-up fixes from
// PPTX_RENDER_FOLLOWUP_PROMPT.md (see inline notes tagged FOLLOW-UP):
//   Tier 1 — real client-side visual reconstruction, via the third-party
//            PPTXjs library (github.com/meshesha/PPTXjs), lazy-loaded on
//            first use and run entirely inside a namespace-isolated
//            same-origin <iframe> (see NAMESPACE ISOLATION below).
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
// slide can't throw out of the fallback chain.
//
// LIBRARY CHOICE (see PPTX_RENDER_HANDOFF_PROMPT.md item 6):
// Tier 1 uses PPTXjs (meshesha/PPTXjs, MIT). Several newer-looking
// "browser pptx renderer" packages turned up in the same research pass
// (pptxviewjs, pptx-viewer, pptx-renderer, pptx-glimpse) but none had a
// track record I could verify beyond their own npm/marketing pages —
// for a dependency parsing arbitrary user-uploaded files, "actively
// maintained" should mean "has an actual multi-year history," not just
// a recent publish date. PPTXjs is the one with that history. The real
// cost is that it's a jQuery plugin bundling JSZip 2.x — see NAMESPACE
// ISOLATION below for how that's contained.
//
// FOLLOW-UP Fix 2 — VERSION PIN: previously `PPTXJS_BASE` pointed at
// `@master`, a moving branch ref — a future push (or a compromised
// commit) to that branch would have started loading into every user's
// browser with no warning. Pinned below to PPTXjs's latest tagged
// release, v1.21.1 (commit 1a9260b, tagged 26 Mar by the maintainer,
// "fixed issues: #16" — github.com/meshesha/PPTXjs/releases). Picked
// the latest tag over an arbitrary older one since it's the version
// with the most bugfixes behind it while still being a maintainer-
// reviewed, named release rather than an untagged commit. Bump this
// deliberately (and re-verify) rather than ever pointing back at a
// branch.
//
// Approx footprint (unminified, via jsDelivr; Tier 2 adds nothing):
// jquery ~90KB, jszip@2.x (PPTXjs's own bundled copy) ~90KB, d3.v3
// ~150KB, nv.d3 ~150KB, dingbat.js ~5KB, pptxjs.js + divs2slides.js
// ~60KB combined — roughly 550KB unminified, a third of that gzipped.
// That's exactly why it's lazy-loaded on first PPTX slide render rather
// than eagerly in <head> — see FOLLOW-UP Fix 5 below for how "first
// render" itself is now further deferred off the import-time critical
// path.
//
// NAMESPACE ISOLATION (why, not just how — renamed from "sandboxed" per
// FOLLOW-UP Fix 3; see that note below): PPTXjs expects a global
// `jQuery`/`$`, and its bundled dependency is JSZip **2.x**, whose
// callback-style API (`.load()`) is incompatible with the JSZip **3.x**
// this app already keeps as a global (extractPptxPages in
// doc-extraction.js needs `.loadAsync`). Loading PPTXjs's scripts into
// the main page would clobber `window.JSZip` out from under the rest of
// the app the moment the user imports a second document. So Tier 1
// builds one hidden, detached, same-origin `<iframe>` (via `srcdoc`)
// the first time it's needed, and loads jQuery/JSZip-2/d3/PPTXjs only
// inside THAT iframe's own `window` — those globals never touch the
// parent page's `window.JSZip`/`window.jQuery`. A same-origin `srcdoc`
// iframe shares the page's origin, so the parent can call straight into
// `iframe.contentWindow` synchronously and pass the in-memory `File`
// (via an object URL) directly — no postMessage plumbing needed. The
// iframe is created once and reused for every later Tier-1 call.
//
// FOLLOW-UP Fix 3 (terminology): this iframe is deliberately given NO
// `sandbox` attribute, and it is not a security boundary against
// untrusted script execution — PPTXjs's own code runs with full
// privileges inside it, same as any script on this page. What it
// actually buys is namespace isolation only (a separate `window` so
// PPTXjs's globals can't collide with this app's). Earlier comments
// here called it "sandboxed," which overclaims a security property it
// doesn't have — corrected throughout to "namespace-isolated." A real
// `sandbox` attribute isn't a good fit here anyway: PPTXjs needs
// `allow-scripts` to run at all and `allow-same-origin` for the parent
// to reach `contentWindow`/`contentDocument` synchronously the way this
// module does — and that combination is the one well-known case where
// `sandbox` provides close to no protection (a sandboxed-but-same-
// origin frame can strip its own sandbox attribute via script and
// reload itself unsandboxed). Adding `sandbox="allow-scripts
// allow-same-origin"` here would add attribute noise without adding
// real containment, so it's intentionally omitted.
//
// GEMINI_MODEL_FIX_AND_PPTX_DIAGNOSTICS_PROMPT.md Issue 2 (diagnostics
// only): renderPptxTier1()/renderPptxTier2() previously only
// console.error'd on unexpected exceptions — there was no log line at
// all for "tier attempted," "tier succeeded," or (most importantly) WHY
// a given `return false` fired, since most of those fall-through paths
// are expected control flow, not errors. Added console.log (never
// console.error, so these stay visually distinct from the existing
// real-failure logs) at entry, at the success point, and at every
// `return false` site with the specific reason. Nothing about which
// branch executes, what's returned, or when has changed — this is
// strictly additive logging.
//
// FOLLOW-UP Fix 5 (deferred first attempt — see renderPptxTier1 below):
// Tier 1's first-ever invocation typically lands at import time,
// running concurrently with this app's AI question-generation pipeline
// and its AI layout-formatting pass — both already network/CPU-heavy
// right after import. To avoid a third heavy client-side operation
// competing with those at the worst possible moment, the very first
// call to renderPptxTier1() now waits for either a browser idle slot
// (`requestIdleCallback`) or a short fixed delay (`setTimeout` fallback
// where `requestIdleCallback` isn't available, e.g. Safari) before
// doing any work — every later call proceeds immediately. This doesn't
// restructure the tier-chain logic in doc-pane-navigation.js at all
// (renderPptxSlide still just awaits renderPptxTier1() the same way);
// it only delays what happens inside this function on the first call.
// Trade-off: worst-case Tier-1-then-fallback latency on that very first
// slide render grows by up to ~1.5s (the idle-callback timeout below).
// A cleaner fix would gate this on Pane 3's actual visibility, but
// pane3 in this layout is an always-visible sticky sidebar rendered
// alongside Pane 1/2 (not a tab the user switches to), so there's no
// "became visible" signal to hook — this idle-defer is the closest
// straightforward approximation without restructuring the pane layout
// itself, which is out of scope here.

const PPTXJS_BASE = 'https://cdn.jsdelivr.net/gh/meshesha/PPTXjs@v1.21.1'; // pinned — see FOLLOW-UP Fix 2 above. Tag v1.21.1 == commit 1a9260b.
const PPTXJS_ASSETS = {
  jquery: 'https://cdn.jsdelivr.net/npm/jquery@1.11.3/dist/jquery.min.js',
  jszip2: `${PPTXJS_BASE}/js/jszip.min.js`, // PPTXjs's own bundled JSZip — v2.x, kept isolated inside the iframe, see NAMESPACE ISOLATION above
  filereader: `${PPTXJS_BASE}/js/filereader.js`,
  d3: `${PPTXJS_BASE}/js/d3.min.js`,
  nvd3: `${PPTXJS_BASE}/js/nv.d3.min.js`,
  dingbat: `${PPTXJS_BASE}/js/dingbat.js`,
  pptxjs: `${PPTXJS_BASE}/js/pptxjs.js`,
  divs2slides: `${PPTXJS_BASE}/js/divs2slides.js`,
  css: `${PPTXJS_BASE}/css/pptxjs.css`,
};

// Module-scope, not state.* — this is rendering-engine plumbing (a lazy
// singleton iframe + a render-in-flight guard), not document data, and
// has no business surviving a hard app reset the way state.* does.
let tier1IframePromise = null; // Promise<HTMLIFrameElement|null>, cached after first successful load
let tier1RenderedFile = null;  // the File object last fully rendered into the iframe, so revisiting a slide in the same deck doesn't re-parse the whole .pptx
let renderToken = 0;           // incremented per Tier-1 call; a superseded in-flight call detects the mismatch and bails without touching the DOM
let tier1FirstCallDeferred = false; // FOLLOW-UP Fix 5 — set once the one-time idle defer has happened

function buildTier1IframeHtml() {
  const scriptTags = [
    PPTXJS_ASSETS.jquery,
    PPTXJS_ASSETS.jszip2,
    PPTXJS_ASSETS.filereader,
    PPTXJS_ASSETS.d3,
    PPTXJS_ASSETS.nvd3,
    PPTXJS_ASSETS.dingbat,
    PPTXJS_ASSETS.pptxjs,
    PPTXJS_ASSETS.divs2slides,
  ].map((src) => `<script src="${src}"></script>`).join('\n    ');

  return `<!DOCTYPE html><html><head>
    <meta charset="utf-8">
    <link rel="stylesheet" href="${PPTXJS_ASSETS.css}">
    <style>html,body{margin:0;background:#fff;} #slideHost{width:100%;}</style>
  </head><body>
    <div id="slideHost"></div>
    ${scriptTags}
  </body></html>`;
}

// Creates (once) the hidden, namespace-isolated iframe (see NAMESPACE
// ISOLATION above) and waits for PPTXjs's own scripts to finish loading
// inside it. Resolves to the iframe element, or null if the CDN scripts
// never became usable (offline, blocked, script error, etc.) — callers
// treat null as "Tier 1 unavailable" and fall straight through to
// Tier 2.
function getTier1Iframe() {
  if (tier1IframePromise) return tier1IframePromise;

  tier1IframePromise = new Promise((resolve) => {
    try {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.setAttribute('aria-hidden', 'true');
      // Deliberately no `sandbox` attribute — see FOLLOW-UP Fix 3 note
      // at the top of this file for why one wouldn't add real
      // containment here anyway.
      iframe.srcdoc = buildTier1IframeHtml();

      const timeoutId = setTimeout(() => resolve(null), 15000);

      iframe.addEventListener('load', () => {
        // The sequential <script> tags inside the srcdoc document load
        // asynchronously relative to the iframe's own 'load' event, so
        // poll briefly for jQuery + the pptxToHtml plugin to attach
        // rather than assuming they're ready the instant 'load' fires.
        const check = () => {
          const w = iframe.contentWindow;
          if (w && w.jQuery && typeof w.jQuery.fn.pptxToHtml === 'function') {
            clearTimeout(timeoutId);
            resolve(iframe);
          } else if (!iframe.isConnected) {
            resolve(null); // torn down before it finished loading
          } else {
            setTimeout(check, 150);
          }
        };
        check();
      });

      document.body.appendChild(iframe);
    } catch (e) {
      console.error('[pptx-render] Tier 1 iframe setup failed:', e);
      resolve(null);
    }
  });

  return tier1IframePromise;
}

// FOLLOW-UP Fix 5 — resolves once, either on the next browser idle slot
// or after a short fixed delay if requestIdleCallback isn't available.
// Only ever awaited once (guarded by tier1FirstCallDeferred), so every
// Tier-1 call after the very first proceeds with no added delay.
function waitForIdleOnce() {
  if (tier1FirstCallDeferred) return Promise.resolve();
  tier1FirstCallDeferred = true;
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: 1500 });
    } else {
      setTimeout(resolve, 400); // Safari and older browsers
    }
  });
}

// ---------------------------------------------------------------------
// Tier 1 — real client-side visual reconstruction via PPTXjs.
// `container` is shown/emptied by the CALLER on success; on success
// this function reparents the (single, reused) iframe itself into
// `container` and makes it visible.
// ---------------------------------------------------------------------
async function renderPptxTier1(container, file, pageNumber) {
  console.log(`[pptx-render] Tier 1: attempting slide ${pageNumber}`, { fileName: file && file.name });

  if (!container || !file) {
    console.log('[pptx-render] Tier 1: false — missing container or file', { hasContainer: !!container, hasFile: !!file });
    return false;
  }

  // FOLLOW-UP Fix 5 — see note at top of file. No-op after the first call.
  await waitForIdleOnce();

  const myToken = ++renderToken;

  const iframe = await getTier1Iframe();
  if (!iframe) {
    console.log('[pptx-render] Tier 1: false — namespace-isolated iframe never became ready (load timeout, script error, or offline)');
    return false;
  }
  if (myToken !== renderToken) {
    console.log('[pptx-render] Tier 1: false — superseded by a newer call before the iframe was ready');
    return false;
  }

  try {
    const w = iframe.contentWindow;
    const d = iframe.contentDocument;
    const host = d.getElementById('slideHost');
    const $ = w.jQuery;

    if (tier1RenderedFile !== file) {
      host.innerHTML = '';
      const objectUrl = URL.createObjectURL(file);

      const rendered = await new Promise((resolve) => {
        const timeoutId = setTimeout(() => resolve(false), 20000);
        try {
          $(host).pptxToHtml({
            pptxFileUrl: objectUrl,
            slideMode: false,
            keyBoardShortCut: false,
            mediaProcess: true,
            slidesScale: '100%',
          });
          // No completion callback in older PPTXjs releases — poll for
          // rendered slide nodes instead of assuming a fixed delay.
          const poll = setInterval(() => {
            if (host.querySelectorAll('.slide, [id^="slide"]').length > 0) {
              clearInterval(poll);
              clearTimeout(timeoutId);
              resolve(true);
            }
          }, 200);
        } catch (e) {
          clearTimeout(timeoutId);
          console.error('[pptx-render] Tier 1 pptxToHtml threw:', e);
          resolve(false);
        }
      });

      URL.revokeObjectURL(objectUrl);
      if (myToken !== renderToken) {
        console.log('[pptx-render] Tier 1: false — superseded by a newer call while pptxToHtml was running');
        return false;
      }
      if (!rendered) {
        tier1RenderedFile = null;
        console.log('[pptx-render] Tier 1: false — pptxToHtml produced no slide nodes within the 20s window (timed out, or it threw — see any error logged just above)');
        return false;
      }
      tier1RenderedFile = file;
    }

    const slideNodes = host.querySelectorAll('.slide, [id^="slide"]');
    const targetNode = slideNodes[pageNumber - 1];
    if (!targetNode) {
      console.log(`[pptx-render] Tier 1: false — no slide node at index ${pageNumber - 1} (deck rendered ${slideNodes.length} slide node(s) total)`);
      return false;
    }

    slideNodes.forEach((n) => { n.style.display = 'none'; });
    targetNode.style.display = '';

    // GEMINI_FIX_REDO_AND_PPTX_STATE_BUG_PROMPT.md follow-up bug — the
    // previous unconditional `container.innerHTML = ''` here would
    // destroy the iframe itself once it was already the container's
    // child from a prior slide's render: removing an iframe from the
    // DOM tears down its browsing context, and the appendChild() right
    // after reinserts it as a brand-new context, which reloads the
    // `srcdoc` from scratch — silently wiping out every slide node
    // PPTXjs had just rendered. That's why only the very first Tier-1
    // call in a session ever succeeded; every later call in the same
    // deck (or a different deck reusing the same singleton iframe) found
    // an empty, freshly-reloaded `slideHost`. Only touch the DOM here
    // when the iframe genuinely isn't already in place.
    if (iframe.parentNode !== container) {
      container.innerHTML = '';
      container.appendChild(iframe);
    }
    iframe.style.cssText = 'display:block; width:100%; height:100%; border:0;';
    console.log(`[pptx-render] Tier 1: true — slide ${pageNumber} rendered (${slideNodes.length} slide node(s) in deck)`);
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
// whatever pictures the slide actually embeds.
// ---------------------------------------------------------------------
async function renderPptxTier2(container, zip, pageNumber) {
  console.log(`[pptx-render] Tier 2: attempting slide ${pageNumber}`);

  if (!container || !zip) {
    console.log('[pptx-render] Tier 2: false — missing container or zip', { hasContainer: !!container, hasZip: !!zip });
    return false;
  }
  try {
    const slidePath = `ppt/slides/slide${pageNumber}.xml`;
    const relsPath = `ppt/slides/_rels/slide${pageNumber}.xml.rels`;
    const slideFile = zip.file(slidePath);
    const relsFile = zip.file(relsPath);
    if (!slideFile || !relsFile) {
      console.log(`[pptx-render] Tier 2: false — ${slidePath} or its .rels file not found in the zip`, { hasSlideFile: !!slideFile, hasRelsFile: !!relsFile });
      return false;
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
      console.log(`[pptx-render] Tier 2: false — no <a:blip r:embed> picture references found on slide ${pageNumber}`, { blipNodeCount: blipNodes.length });
      return false;
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
      console.log(`[pptx-render] Tier 2: false — found ${mediaPaths.length} media reference(s) but none resolved to a blob`, { mediaPaths });
      return false;
    }

    // Same hazard as Tier 1's own reinsertion bug (see the comment on
    // that fix above): this container is reused across slides, and if
    // Tier 1 previously succeeded here, the iframe holding its whole
    // rendered deck is currently sitting inside `container`. An
    // unconditional innerHTML clear would destroy that iframe (removing
    // it from the DOM tears down its browsing context), silently and
    // permanently breaking Tier 1 for every later slide in this session
    // — since `tier1RenderedFile` never resets to force a re-render.
    // Detach it to a hidden spot instead of discarding it, so a later
    // Tier-1 call can still find and reuse it.
    const parkedIframe = container.querySelector('iframe');
    if (parkedIframe) {
      parkedIframe.style.display = 'none';
      document.body.appendChild(parkedIframe);
    }
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

export { renderPptxTier1, renderPptxTier2 };