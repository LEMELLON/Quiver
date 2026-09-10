// main.js — app orchestrator: imports every module, wires the handful of listeners not owned by any single module, and runs init.

import './core-state.js';
import './dom-refs.js';
import './classification-meta.js';
import './shared-constants.js';

import './seed-api-key.js';
import './ai-credentials-and-models.js';

import { addQuestion, sortQuestionsByPage, updateQuestionCount } from './question-model.js';
import { setParseStatus } from './status-helpers.js';
import { setActiveCard, renderQuestionNav, resetTermSearchOnSourceSwitch, registerSourceSwitcher } from './editor-render.js';
import { extractPptxPages, extractPdfPages } from './doc-extraction.js';
import './text-normalize.js';
import { markQidList } from './highlighting.js';
import { renderTextVersion, formatAllPagesLayout } from './layout-formatting.js';
import './selection-toolbar.js';
import './variant-generation.js';
import './snippet-question-generation.js';
import './ai-prompt-builders.js';
import { generateQuestionsWithAI } from './ai-api-calls.js';
import { setupNavRange, renderDocPage } from './doc-pane-navigation.js';
import './quiz-export.js';
import './batch-scan.js';
import { renderPptxTier1Thumbnail, getPptxThumbnailDataUrl, pauseTier1Scaling, resumeTier1Scaling } from './pptx-render.js';
import { renderPdfPageToDataUrl } from './pdf-render.js';

import { state, createSource } from './core-state.js';
import {
  docTextContainer,
  pdfFileInput,
  quizTitleInput,
  docPanelTitle,
  pdfEmptyState,
  pdfCanvas,
  slideTextPreview,
  importDetailsEl,
  sourceStackAreaEl,
  sourceListEl,
  sourcePaneEl,
  layoutRootEl,
  sourcePanelToggleBtn,
  sourcePanelDividerEl,
  pane1,
  pane1DividerEl,
  pane2DividerEl,
  motherPaneEl,
  motherPaneDividerEl,
  pane1FloatToggleBtn,
  pane1FloatShell,
  pane1FloatHeader,
  pane1FloatBody,
  pane1CollapseToggleBtn,
  pane1DockBtn,
  termPanelPopup,
  termPanelToggleBtn,
} from './dom-refs.js';

// Clicking a shared highlight mark activates the first question id in its data-qid list.
docTextContainer.addEventListener('click', (e) => {
  const mark = e.target.closest('mark[data-qid]');
  if (mark) setActiveCard(markQidList(mark)[0]);
});

// Imports one or more PDF/PPTX files: extracts text, generates AI questions per file, and appends/replaces state.questions accordingly.
async function importFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  const isFirstImportBatch = state.sources.length === 0;
  let questionsReplaced = false;
  let lastFile = null;
  let lastGenerated = null;
  let sawError = false;

  for (const file of files) {
    const isPptx = /\.pptx$/i.test(file.name) || (file.type || '').includes('presentation');
    const isPdf = /\.pdf$/i.test(file.name) || (file.type || '') === 'application/pdf';
    if (!isPptx && !isPdf) {
      setParseStatus(`Skipped "${file.name}" — please choose a .pdf or .pptx file.`, 'error');
      sawError = true;
      continue;
    }

    setParseStatus(files.length > 1 ? `Reading "${file.name}"…` : 'Reading file…');
    try {
      createSource(file.name);

      let pages;
      if (isPptx) {
        if (typeof JSZip === 'undefined') throw new Error('JSZip failed to load — check your network connection.');
        state.docType = 'pptx';
        setParseStatus(`Extracting slide text from "${file.name}"…`);
        pages = await extractPptxPages(file);
      } else {
        if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js failed to load — check your network connection.');
        if (typeof Tesseract === 'undefined') throw new Error('OCR engine failed to load — check your network connection.');
        state.docType = 'pdf';
        setParseStatus(`Extracting page text from "${file.name}"…`);
        pages = await extractPdfPages(file);
      }

      if (pages.length === 0) throw new Error(`No pages or slides were found in "${file.name}".`);

      // Runs layout formatting in the background without awaiting; it re-renders Pane 2 on its own once done.
      state.pages = pages;
      formatAllPagesLayout();

      const generated = await generateQuestionsWithAI(pages);

      if (isFirstImportBatch && !questionsReplaced) {
        state.questions = generated; // exact original single-file behavior
        questionsReplaced = true;
      } else {
        state.questions = state.questions.concat(generated);
      }
      sortQuestionsByPage();

      lastFile = file;
      lastGenerated = generated;
      renderSourceList();
    } catch (err) {
      console.error(err);
      sawError = true;
      setParseStatus(`"${file.name}": ${err.message || 'Failed to parse that document.'}`, 'error');
    }
  }

  if (!lastFile) return; // every file in this selection was skipped or failed

  state.activeCardId = null;
  quizTitleInput.value = lastFile.name.replace(/\.(pdf|pptx)$/i, '');
  docPanelTitle.textContent = lastFile.name;

  setupNavRange();
  pdfEmptyState.classList.add('hidden');
  if (state.docType === 'pdf') {
    pdfCanvas.classList.remove('hidden');
    slideTextPreview.classList.add('hidden');
  } else {
    pdfCanvas.classList.add('hidden');
    slideTextPreview.classList.remove('hidden');
  }

  renderTextVersion();
  updateQuestionCount();
  if (lastGenerated && lastGenerated.length) setActiveCard(lastGenerated[0].id);
  importDetailsEl.open = false;

  if (!sawError) {
    setParseStatus(
      files.length > 1
        ? `Imported ${files.length} file${files.length === 1 ? '' : 's'}.`
        : `Generated ${lastGenerated.length} question${lastGenerated.length === 1 ? '' : 's'} from "${lastFile.name}".`,
      'success'
    );
  }
}

pdfFileInput.addEventListener('change', (e) => {
  importFiles(e.target.files);
});

// Lets files be dragged from the OS onto the source-stack area to import them.
if (sourceStackAreaEl) {
  const isFileDrag = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));

  sourceStackAreaEl.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    sourceStackAreaEl.classList.add('source-dropzone-active');
  });

  sourceStackAreaEl.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); // required for this element to accept a drop at all
    e.dataTransfer.dropEffect = 'copy';
    sourceStackAreaEl.classList.add('source-dropzone-active');
  });

  sourceStackAreaEl.addEventListener('dragleave', (e) => {
    // Only clears the highlight once the drag leaves the whole wrapper, not just moves between children.
    if (e.target === sourceStackAreaEl) sourceStackAreaEl.classList.remove('source-dropzone-active');
  });

  sourceStackAreaEl.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    sourceStackAreaEl.classList.remove('source-dropzone-active');
    importFiles(e.dataTransfer.files);
  });
}

// ---------- Source panel / Pane 1 / #motherPane continuous drag-resize (batch 4, restructured in 5A) ----------
// applyWidth() is the ONLY place that writes --source-panel-w / --pane1-w / --mother-pane-w on #layoutRoot —
// both the drag handlers below and the toggle button's click handler funnel through it, per the batch-4
// handoff's requirement that there be a single code path for writing a pane's width. The internal pane2/pane3
// fr-split has its own single-writer function, applyInternalSplit(), a few lines below setupPaneDrag().

// minWidth/maxWidth for the source panel are grounded in batch 3's actual CSS (96px collapsed thumb-only
// row) and the handoff's own values. pane1/motherPane's min/max and the source panel's expandedWidth are NOT
// specified anywhere in the handoff — these are reasonable placeholder defaults, not extracted from a spec,
// and should be confirmed against the real design before shipping (flagged in the batch-4 and 5A handbacks).
const PANE_DRAG_CONFIG = {
  source: {
    varName: '--source-panel-w',
    minWidth: 96,          // thumb-only collapsed width — matches batch 3's CSS and the .source-stack-meta breakpoint
    maxWidth: 480,          // ASSUMPTION — not specified in the handoff
    collapsedWidth: 96,
    expandedWidth: 320,     // ASSUMPTION — approximate fixed-px stand-in for the old minmax(220px, 0.8fr); the
                             // handoff itself flagged minmax() as having "patchy behavior" as a custom-property
                             // value, so a fixed px was used instead per its own suggestion. Not visually verified.
  },
  // pane2 is no longer a px-tracked pane on the outer grid as of batch 5A — it's the fr-split inside
  // #motherPane now (see applyInternalSplit()/setupInternalSplitDrag() below). pane1 and motherPane take
  // over the outer-grid px tracks that Pane 1/Pane 3's old bare-1.4fr columns used to occupy.
  // onOvershoot (batch 5C): setupPaneDrag() calls this instead of clamping at minWidth when the drag keeps
  // going past minWidth by more than AUTO_FLOAT_OVERSHOOT_PX — auto-floats Pane 1 rather than pinning it at
  // its minimum. Kept as a config-level callback (not a paneKey === 'pane1' branch inside setupPaneDrag)
  // so the drag function itself stays pane-agnostic.
  pane1: {
    varName: '--pane1-w',
    minWidth: 380,   // ASSUMPTION — confirm against design. Also the threshold batch 5C's auto-float trigger reads.
    maxWidth: 640,   // ASSUMPTION — static ceiling only; getMaxWidth() below can tighten it further at drag time.
    onOvershoot: () => floatPane1('auto'),
    // Static maxWidth alone isn't safe: #motherPane's grid track is minmax(var(--mother-pane-w), 1fr)
    // (styles.css), so growing pane1 past `viewport content width - source-panel-w - mother-pane-w's current
    // floor` forces the grid wider than the viewport instead of actually shrinking #motherPane. getMaxWidth()
    // computes that live ceiling; setupPaneDrag takes the smaller of this and the static maxWidth.
    getMaxWidth: () => getPane1EffectiveMaxWidth(),
  },
  motherPane: {
    varName: '--mother-pane-w',
    minWidth: 480,   // ASSUMPTION
    maxWidth: 1400,  // ASSUMPTION
  },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// How far past Pane 1's minWidth a drag has to overshoot before setupPaneDrag hands off to
// PANE_DRAG_CONFIG.pane1.onOvershoot() instead of just clamping there (batch 5C). Reaching exactly minWidth
// and stopping is itself a normal, desired resize — only overshooting past it by this much means "float it".
const AUTO_FLOAT_OVERSHOOT_PX = 24; // ASSUMPTION — confirm this feels right, not too eager/too sticky; needs a live browser to tune.

// Step sizes for keyboard resizing.
const KEY_STEP = 16;
const KEY_STEP_LARGE = 48;

// Syncs a divider's aria-value* attributes with the pane's current width.
function updateDividerAria(dividerEl, cfg, widthPx) {
  dividerEl.setAttribute('aria-valuemin', String(cfg.minWidth));
  dividerEl.setAttribute('aria-valuemax', String(cfg.maxWidth));
  dividerEl.setAttribute('aria-valuenow', String(Math.round(widthPx)));
}

// Reads a pane's current rendered width once. Only ever called at drag start or from the toggle button —
// NEVER from inside a pointermove handler, which is the #1 cause of drag jank (see batch-4 handoff).
function getPaneCurrentWidthPx(paneEl) {
  return paneEl.getBoundingClientRect().width;
}

// Pane 1's effective max width isn't just PANE_DRAG_CONFIG.pane1.maxWidth — it also can't be allowed to grow
// past however much room is actually left before #motherPane would be pushed below its own current floor.
// #motherPane's grid track is minmax(var(--mother-pane-w), 1fr) (styles.css), so that floor is whatever
// --mother-pane-w is *currently* set to (last value #motherPaneDivider was dragged to), not
// PANE_DRAG_CONFIG.motherPane.minWidth — those are two independent numbers. Reads live (clientWidth, computed
// padding/gap, current --mother-pane-w, current source panel width) rather than caching, since viewport size
// and --mother-pane-w can each change independently of a pane1 drag. Called once at pointerdown/keydown, same
// "read at drag start only" discipline as startWidth above — never from inside onPointerMove.
function getPane1EffectiveMaxWidth() {
  const cfg = PANE_DRAG_CONFIG.pane1;
  if (!layoutRootEl || !sourcePaneEl) return cfg.maxWidth;
  const rootStyles = getComputedStyle(layoutRootEl);
  const contentWidth = layoutRootEl.clientWidth
    - parseFloat(rootStyles.paddingLeft) - parseFloat(rootStyles.paddingRight);
  const gapPx = parseFloat(rootStyles.columnGap) || 0; // 2 gaps: source↔pane1, pane1↔motherPane
  const sourcePanelWidth = getPaneCurrentWidthPx(sourcePaneEl);
  const motherPaneFloor = parseFloat(rootStyles.getPropertyValue('--mother-pane-w')) || PANE_DRAG_CONFIG.motherPane.minWidth;
  const available = contentWidth - gapPx * 2 - sourcePanelWidth - motherPaneFloor;
  return Math.min(cfg.maxWidth, Math.max(cfg.minWidth, available));
}

// The single function that writes a pane's width. Pure style write, no DOM reads, safe to call once per
// animation frame from a drag handler or once from a click handler.
function applyWidth(paneKey, widthPx) {
  const cfg = PANE_DRAG_CONFIG[paneKey];
  if (!layoutRootEl || !cfg) return null;
  const clamped = clamp(widthPx, cfg.minWidth, cfg.maxWidth);
  layoutRootEl.style.setProperty(cfg.varName, `${clamped}px`);
  return clamped;
}

// Wires one divider to one pane: pointer events + pointer capture (not mousemove on document), width cached
// once at pointerdown, DOM writes batched to requestAnimationFrame — see the batch-4 handoff's "Why naive
// drag-resize gets laggy" section for why each of these choices matters.
function setupPaneDrag(paneKey, dividerEl, paneEl) {
  if (!dividerEl || !paneEl) return;
  const cfg = PANE_DRAG_CONFIG[paneKey];
  let startX = 0;
  let startWidth = 0;
  let pendingWidth = null;
  let rafId = null;
  let dragMaxWidth = cfg.maxWidth; // recomputed at pointerdown below when cfg.getMaxWidth exists (pane1 only)

  updateDividerAria(dividerEl, cfg, getPaneCurrentWidthPx(paneEl));

  function onPointerMove(e) {
    // Pure arithmetic only — no getBoundingClientRect/clientWidth/offsetWidth reads here.
    const rawRequested = startWidth + (e.clientX - startX); // unclamped, used only for the overshoot check below
    if (cfg.onOvershoot && rawRequested < cfg.minWidth - AUTO_FLOAT_OVERSHOOT_PX) {
      // Dragged past minWidth by more than the overshoot buffer — end this drag session cleanly, then
      // hand off to the pane-specific overshoot behavior (batch 5C), instead of clamping at minWidth like a
      // normal resize. Reaching exactly minWidth and stopping there is itself a normal, desired resize.
      dividerEl.removeEventListener('pointermove', onPointerMove);
      try { dividerEl.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
      paneEl.style.willChange = '';
      dividerEl.classList.remove('dragging');
      resumeTier1Scaling();
      cfg.onOvershoot();
      return;
    }
    pendingWidth = clamp(rawRequested, cfg.minWidth, dragMaxWidth);
    if (rafId == null) {
      rafId = requestAnimationFrame(() => {
        applyWidth(paneKey, pendingWidth);
        updateDividerAria(dividerEl, cfg, pendingWidth);
        rafId = null;
      });
    }
  }

  function onPointerUp(e) {
    dividerEl.removeEventListener('pointermove', onPointerMove);
    try { dividerEl.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    paneEl.style.willChange = '';
    dividerEl.classList.remove('dragging');
    resumeTier1Scaling();
  }

  dividerEl.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return; // primary button/touch only
    dividerEl.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startWidth = getPaneCurrentWidthPx(paneEl); // read once, here only
    dragMaxWidth = cfg.getMaxWidth ? Math.min(cfg.maxWidth, cfg.getMaxWidth()) : cfg.maxWidth;
    paneEl.style.willChange = 'width';
    dividerEl.classList.add('dragging');
    pauseTier1Scaling();
    dividerEl.addEventListener('pointermove', onPointerMove);
    dividerEl.addEventListener('pointerup', onPointerUp, { once: true });
  });

  // Left/Right step the pane's width, Shift+Left/Right take a bigger step, Home/End jump to min/max.
  dividerEl.addEventListener('keydown', (e) => {
    const current = getPaneCurrentWidthPx(paneEl);
    // Cheap to recompute per keypress (not a drag loop) — same dynamic ceiling as the pointer-drag path above.
    const effectiveMaxWidth = cfg.getMaxWidth ? Math.min(cfg.maxWidth, cfg.getMaxWidth()) : cfg.maxWidth;
    let targetWidth;
    if (e.key === 'ArrowLeft') {
      targetWidth = current - (e.shiftKey ? KEY_STEP_LARGE : KEY_STEP);
    } else if (e.key === 'ArrowRight') {
      targetWidth = current + (e.shiftKey ? KEY_STEP_LARGE : KEY_STEP);
    } else if (e.key === 'Home') {
      targetWidth = cfg.minWidth;
    } else if (e.key === 'End') {
      targetWidth = effectiveMaxWidth;
    } else {
      return;
    }
    e.preventDefault();
    const clamped = applyWidth(paneKey, Math.min(targetWidth, effectiveMaxWidth));
    updateDividerAria(dividerEl, cfg, clamped);
  });
}

setupPaneDrag('source', sourcePanelDividerEl, sourcePaneEl);
setupPaneDrag('pane1', pane1DividerEl, pane1);
setupPaneDrag('motherPane', motherPaneDividerEl, motherPaneEl);

// ---------- Internal pane2/pane3 fr-split drag (batch 5A) ----------
// #pane2Divider now resizes the pane2:pane3 ratio *inside* #motherPane only — it can't reuse setupPaneDrag()
// as-is because that function writes a single px custom property; this one writes two fr custom properties
// computed relative to #motherPane's own content width. --pane2-fr/--pane3-fr live on #layoutRoot (same as
// every other pane width var) and drive #motherPane's own grid-template-columns in styles.css — dragging
// divider A/B (Pane 1 or #motherPane's own outer-grid width) changes #motherPane's total width for free via
// fr units, with no JS recompute needed on that path; this function only fires when the internal divider
// itself moves. Same performance discipline as setupPaneDrag(): one bounding-rect read at pointerdown only,
// arithmetic-only in pointermove, single requestAnimationFrame-batched write, pointer capture.
const INTERNAL_SPLIT_TOTAL_FR = 2;
const INTERNAL_SPLIT_MIN_FR = 0.4;  // ASSUMPTION — confirm neither pane visually collapses at this ratio
const INTERNAL_SPLIT_MAX_FR = INTERNAL_SPLIT_TOTAL_FR - INTERNAL_SPLIT_MIN_FR;
const INTERNAL_SPLIT_KEY_STEP = 0.1;
const INTERNAL_SPLIT_KEY_STEP_LARGE = 0.3;

// The single function that writes the internal split. Pure style write, no DOM reads, safe to call once per
// animation frame from the drag handler or once from the keydown handler.
function applyInternalSplit(pane2Fr) {
  const clamped = clamp(pane2Fr, INTERNAL_SPLIT_MIN_FR, INTERNAL_SPLIT_MAX_FR);
  layoutRootEl.style.setProperty('--pane2-fr', clamped + 'fr');
  layoutRootEl.style.setProperty('--pane3-fr', (INTERNAL_SPLIT_TOTAL_FR - clamped) + 'fr');
  return clamped;
}

// Reads the current pane2 fr value once. Only called at drag start, from the keydown handler, or to seed
// aria attributes — NEVER from inside a pointermove handler.
function getCurrentPane2Fr() {
  const raw = getComputedStyle(layoutRootEl).getPropertyValue('--pane2-fr').trim();
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : INTERNAL_SPLIT_TOTAL_FR / 2;
}

// Syncs the internal divider's aria-value* attributes with the current pane2 fr share.
function updateInternalSplitAria(dividerEl, pane2Fr) {
  dividerEl.setAttribute('aria-valuemin', String(INTERNAL_SPLIT_MIN_FR));
  dividerEl.setAttribute('aria-valuemax', String(INTERNAL_SPLIT_MAX_FR));
  dividerEl.setAttribute('aria-valuenow', pane2Fr.toFixed(2));
}

function setupInternalSplitDrag(dividerEl, motherPaneEl) {
  if (!dividerEl || !motherPaneEl) return;
  let startX = 0, startFr = 0, motherWidthPx = 0, pendingFr = null, rafId = null;

  updateInternalSplitAria(dividerEl, getCurrentPane2Fr());

  function onPointerMove(e) {
    // Pure arithmetic only — no getBoundingClientRect reads here.
    const deltaFr = ((e.clientX - startX) / motherWidthPx) * INTERNAL_SPLIT_TOTAL_FR;
    pendingFr = clamp(startFr + deltaFr, INTERNAL_SPLIT_MIN_FR, INTERNAL_SPLIT_MAX_FR);
    if (rafId == null) {
      rafId = requestAnimationFrame(() => {
        applyInternalSplit(pendingFr);
        updateInternalSplitAria(dividerEl, pendingFr);
        rafId = null;
      });
    }
  }
  function onPointerUp(e) {
    dividerEl.removeEventListener('pointermove', onPointerMove);
    try { dividerEl.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    motherPaneEl.style.willChange = '';
    dividerEl.classList.remove('dragging');
    resumeTier1Scaling();
  }
  dividerEl.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return; // primary button/touch only
    dividerEl.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startFr = getCurrentPane2Fr();
    motherWidthPx = motherPaneEl.getBoundingClientRect().width; // read once, here only
    motherPaneEl.style.willChange = 'grid-template-columns';
    dividerEl.classList.add('dragging');
    pauseTier1Scaling();
    dividerEl.addEventListener('pointermove', onPointerMove);
    dividerEl.addEventListener('pointerup', onPointerUp, { once: true });
  });

  // Left/Right step the pane2 fr share, Shift+Left/Right take a bigger step, Home/End jump to min/max.
  dividerEl.addEventListener('keydown', (e) => {
    const current = getCurrentPane2Fr();
    let targetFr;
    if (e.key === 'ArrowLeft') {
      targetFr = current - (e.shiftKey ? INTERNAL_SPLIT_KEY_STEP_LARGE : INTERNAL_SPLIT_KEY_STEP);
    } else if (e.key === 'ArrowRight') {
      targetFr = current + (e.shiftKey ? INTERNAL_SPLIT_KEY_STEP_LARGE : INTERNAL_SPLIT_KEY_STEP);
    } else if (e.key === 'Home') {
      targetFr = INTERNAL_SPLIT_MIN_FR;
    } else if (e.key === 'End') {
      targetFr = INTERNAL_SPLIT_MAX_FR;
    } else {
      return;
    }
    e.preventDefault();
    const clamped = applyInternalSplit(targetFr);
    updateInternalSplitAria(dividerEl, clamped);
  });
}

setupInternalSplitDrag(pane2DividerEl, motherPaneEl);

// Toggle button: snaps --source-panel-w between the collapsed/expanded presets through the same applyWidth()
// the drag handler above uses (batch-4 decision #3 — kept, not removed, so keyboard/screen-reader users can
// still expand/collapse without pointer drag). .source-panel-expanded stays on #sourcePane only, for
// .source-stack-meta's show/hide in styles.css — that rule is unrelated to width and isn't being replaced.
if (sourcePanelToggleBtn && sourcePaneEl) {
  sourcePanelToggleBtn.addEventListener('click', () => {
    const cfg = PANE_DRAG_CONFIG.source;
    const isCurrentlyCollapsed = getPaneCurrentWidthPx(sourcePaneEl) <= cfg.minWidth + 1; // +1px tolerance
    const expanded = isCurrentlyCollapsed;
    const clamped = applyWidth('source', expanded ? cfg.expandedWidth : cfg.collapsedWidth);
    if (sourcePanelDividerEl) updateDividerAria(sourcePanelDividerEl, cfg, clamped);
    sourcePaneEl.classList.toggle('source-panel-expanded', expanded);
    sourcePanelToggleBtn.setAttribute('aria-expanded', String(expanded));
    sourcePanelToggleBtn.title = expanded ? 'Collapse source panel' : 'Expand source panel';
  });
}

// ---------- Floating Pane 1 (batch 5B) ----------
// Manual-trigger only — no auto-float-on-drag or auto-float-on-shrink logic here yet (that's batch 5C).
// #pane1's actual DOM node is reparented (not cloned/rebuilt) between #layoutRoot and #pane1FloatBody, so
// every existing listener/ref on it (question nav, add/remove, editor fields, etc.) keeps working untouched —
// nothing else needs to know #pane1 moved. Note: #pane1 still carries its own lg:sticky/lg:max-h-[...]
// Tailwind utilities from the grid layout; these are inert once it's inside the shell's own flex/overflow
// container, but flag if any visual quirk shows up there — not addressed in this batch.
let pane1Floating = false;
// null | 'manual' | 'auto' — which trigger floated Pane 1 (batch 5C). A manually-floated panel (via the
// button/toggle, 5B) must never be auto-redocked out from under the user; only an auto-floated one is
// eligible for Trigger 2's auto-redock below. Reset to null on every dockPane1() so a later auto-float in the
// same session is never mistakenly attributed to a previous one.
let pane1FloatReason = null;

// Reads/writes the shell's position once per call — used at drag-end-adjacent points (inside the drag's rAF
// callback, once per frame, and on window resize), not on every raw pointermove tick. This is the project's
// existing "one read per frame, not per event" discipline rather than setupPaneDrag's stricter "zero reads in
// pointermove" rule — if this causes jank in practice, move the clamp to pointerup-only instead of every rAF tick.
function clampShellToViewport() {
  if (!pane1FloatShell) return;
  const rect = pane1FloatShell.getBoundingClientRect();
  const maxLeft = Math.max(0, window.innerWidth - rect.width);
  const maxTop = Math.max(0, window.innerHeight - rect.height);
  const currentLeft = parseFloat(pane1FloatShell.style.left) || 0;
  const currentTop = parseFloat(pane1FloatShell.style.top) || 0;
  pane1FloatShell.style.left = `${clamp(currentLeft, 0, maxLeft)}px`;
  pane1FloatShell.style.top = `${clamp(currentTop, 0, maxTop)}px`;
}

// Undocks #pane1 into the floating shell. The outer grid's --pane1-w track collapses out entirely (via the
// .pane1-floating class in styles.css) so #motherPane reclaims the freed space, rather than leaving a dead gap.
// reason: 'manual' (default — the 5B button/toggle) or 'auto' (batch 5C's overshoot-drag/window-shrink
// triggers) — recorded in pane1FloatReason so dockPane1()'s caller and the resize-driven auto-redock check
// below can tell which kind of float this is.
function floatPane1(reason = 'manual') {
  if (pane1Floating || !pane1FloatShell || !pane1FloatBody || !pane1) return;
  pane1Floating = true;
  pane1FloatReason = reason;
  pane1FloatBody.appendChild(pane1);
  pane1FloatShell.classList.remove('hidden');
  layoutRootEl.classList.add('pane1-floating');
  pane1FloatToggleBtn.setAttribute('aria-pressed', 'true');
  clampShellToViewport();
  if (termPanelOpen) closeTermPanel(); // closes rather than trying to live-reposition against a moving anchor mid-transition
}

// Redocks #pane1 back into #layoutRoot. Grid order is fixed (source, pane1, motherPane — #termPanelPopup is a
// fixed-position sibling outside grid flow, not a track, so it never needs to be accounted for here), so this
// is just an insertBefore against #motherPane — no separate anchor/bookmark node needs to be tracked.
function dockPane1() {
  if (!pane1Floating || !pane1 || !motherPaneEl) return;
  pane1Floating = false;
  pane1FloatReason = null;
  layoutRootEl.insertBefore(pane1, motherPaneEl);
  pane1FloatShell.classList.add('hidden');
  layoutRootEl.classList.remove('pane1-floating');
  pane1FloatToggleBtn.setAttribute('aria-pressed', 'false');
  if (termPanelOpen) closeTermPanel(); // closes rather than trying to live-reposition against a moving anchor mid-transition
}

if (pane1FloatToggleBtn) {
  pane1FloatToggleBtn.addEventListener('click', () => {
    pane1Floating ? dockPane1() : floatPane1();
  });
}
if (pane1DockBtn) pane1DockBtn.addEventListener('click', dockPane1);

// ---------- Term panel popup (batch: Term Panel as a Pane-1 Popup handoff) ----------
// Manually toggled only (never auto-shown). Positioning and z-index both depend on
// pane1Floating at the moment it's opened — docked and floating each get a distinct
// anchor and z-index (see the two branches below). Closes automatically on any
// dock/float transition rather than trying to live-reposition against a moving anchor
// mid-transition (see the ADDED lines inside floatPane1()/dockPane1() above), and on
// window resize / outside click / Escape (see further below).
let termPanelOpen = false;

function positionTermPanelDocked() {
  if (!pane1 || !termPanelPopup) return;
  const rect = pane1.getBoundingClientRect();
  termPanelPopup.style.zIndex = '20'; // same slot #termBarDetails' old standalone popup used pre-Move-Into-Pane2
  termPanelPopup.style.top = `${Math.max(8, rect.top)}px`;
  termPanelPopup.style.left = `${rect.right + 12}px`;
}

function positionTermPanelFloating() {
  if (!pane1FloatShell || !termPanelPopup) return;
  const rect = pane1FloatShell.getBoundingClientRect();
  termPanelPopup.style.zIndex = '46'; // one above .pane1-float-shell's 45, still below #quizCodeModal's 50
  termPanelPopup.style.top = `${rect.top}px`;
  termPanelPopup.style.left = `${rect.right + 12}px`;
}

// Clamps the already-positioned popup to stay fully on-screen, same spirit as clampShellToViewport() —
// called after either positioning branch above.
function clampTermPanelToViewport() {
  if (!termPanelPopup) return;
  const rect = termPanelPopup.getBoundingClientRect();
  const maxLeft = Math.max(0, window.innerWidth - rect.width);
  const maxTop = Math.max(0, window.innerHeight - rect.height);
  const currentLeft = parseFloat(termPanelPopup.style.left) || 0;
  const currentTop = parseFloat(termPanelPopup.style.top) || 0;
  termPanelPopup.style.left = `${clamp(currentLeft, 0, maxLeft)}px`;
  termPanelPopup.style.top = `${clamp(currentTop, 0, maxTop)}px`;
}

function openTermPanel() {
  if (!termPanelPopup) return;
  termPanelOpen = true;
  termPanelPopup.classList.remove('hidden');
  pane1Floating ? positionTermPanelFloating() : positionTermPanelDocked();
  clampTermPanelToViewport();
  if (termPanelToggleBtn) termPanelToggleBtn.setAttribute('aria-pressed', 'true');
}

function closeTermPanel() {
  if (!termPanelPopup) return;
  termPanelOpen = false;
  termPanelPopup.classList.add('hidden');
  if (termPanelToggleBtn) termPanelToggleBtn.setAttribute('aria-pressed', 'false');
}

if (termPanelToggleBtn) {
  termPanelToggleBtn.addEventListener('click', () => {
    termPanelOpen ? closeTermPanel() : openTermPanel();
  });
}

// Standard popup dismissal: outside click or Escape.
document.addEventListener('mousedown', (e) => {
  if (!termPanelOpen) return;
  if (termPanelPopup.contains(e.target) || e.target === termPanelToggleBtn) return;
  closeTermPanel();
});
document.addEventListener('keydown', (e) => {
  if (termPanelOpen && e.key === 'Escape') closeTermPanel();
});

// Collapse toggle: hides the shell body only, independent of dock state — doesn't call floatPane1()/dockPane1().
if (pane1CollapseToggleBtn && pane1FloatShell) {
  pane1CollapseToggleBtn.addEventListener('click', () => {
    const collapsed = pane1FloatShell.classList.toggle('collapsed');
    pane1CollapseToggleBtn.setAttribute('aria-expanded', String(!collapsed));
    clampShellToViewport(); // header-only height may now fit somewhere it didn't before
  });
}

// Drag by header — same pointer-capture/rAF discipline as the pane dividers. Works identically in collapsed
// and expanded states since it only ever moves the shell's top/left, never touches its height.
(function setupFloatShellDrag() {
  if (!pane1FloatHeader || !pane1FloatShell) return;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0, pending = null, rafId = null;

  function onPointerMove(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    pending = { left: startLeft + dx, top: startTop + dy };
    if (rafId == null) {
      rafId = requestAnimationFrame(() => {
        pane1FloatShell.style.left = `${pending.left}px`;
        pane1FloatShell.style.top = `${pending.top}px`;
        clampShellToViewport();
        rafId = null;
      });
    }
  }
  function onPointerUp(e) {
    pane1FloatHeader.removeEventListener('pointermove', onPointerMove);
    try { pane1FloatHeader.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    pane1FloatHeader.classList.remove('dragging');
  }
  pane1FloatHeader.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.pane1-float-controls')) return; // don't start a drag from the buttons
    if (e.button !== undefined && e.button !== 0) return;
    pane1FloatHeader.setPointerCapture(e.pointerId);
    const rect = pane1FloatShell.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    pane1FloatHeader.classList.add('dragging');
    pane1FloatHeader.addEventListener('pointermove', onPointerMove);
    pane1FloatHeader.addEventListener('pointerup', onPointerUp, { once: true });
  });
})();

// Re-clamp on window resize so a floating shell never gets stranded off-screen.
window.addEventListener('resize', () => {
  if (pane1Floating) clampShellToViewport();
  // A resize can invalidate the term popup's anchor-relative position the same way it can for the float
  // shell; re-deriving position on resize is more complexity than this feature needs, so just close it.
  if (termPanelOpen) closeTermPanel();
});

// rAF-batched the same way setupPaneDrag() batches pointermove reads/writes ("recorded... once per
// frame... not on every raw pointermove tick") — re-anchors the term popup on scroll instead of
// recomputing layout on every raw scroll tick. capture: true so this also catches scrolls inside
// inner containers (#docTextViewport etc.), not just the document itself.
let termPanelScrollRaf = null;
window.addEventListener('scroll', () => {
  if (!termPanelOpen) return;
  if (termPanelScrollRaf) return;
  termPanelScrollRaf = requestAnimationFrame(() => {
    termPanelScrollRaf = null;
    pane1Floating ? positionTermPanelFloating() : positionTermPanelDocked();
    clampTermPanelToViewport();
  });
}, { passive: true, capture: true });

// ---------- Trigger 2 — auto-float/auto-redock on window resize (batch 5C) ----------
// Debounced separately from the immediate re-clamp listener above (that one only repositions an already-
// floating shell every tick; this one decides whether to float/redock at all, which is heavier and doesn't
// need to run on every raw resize event). Only applies at the >=1024px grid breakpoint — below that, the
// layout already stacks to a single column (.pane-divider { display: none } below 1024px), which solves the
// space problem by scrolling instead of floating.
const RESIZE_DEBOUNCE_MS = 150; // ASSUMPTION — tunable by feel, needs a live browser to get right.
const REDOCK_HYSTERESIS_PX = 120; // ASSUMPTION — gap above the 1024px float threshold before auto-redocking, to prevent flicker right at the line.
let resizeDebounceTimer = null;

function checkAutoFloatOnResize() {
  if (window.innerWidth < 1024) return; // mobile stack already handles this

  if (!pane1Floating) {
    // Pane 1 is docked — check if it's being squeezed below its own minWidth by the grid (source/motherPane/
    // term all fighting for space at this viewport width).
    if (!pane1) return;
    const rect = pane1.getBoundingClientRect();
    if (rect.width > 0 && rect.width < PANE_DRAG_CONFIG.pane1.minWidth) {
      floatPane1('auto');
    }
    return;
  }

  if (pane1FloatReason === 'auto') {
    // Only auto-floated panels are eligible to auto-redock — a manually-floated one (5B's button) only
    // redocks via its own manual controls, no matter how wide the window gets.
    if (window.innerWidth >= 1024 + REDOCK_HYSTERESIS_PX) {
      dockPane1();
    }
  }
}

window.addEventListener('resize', () => {
  if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = setTimeout(checkAutoFloatOnResize, RESIZE_DEBOUNCE_MS);
});

// Makes the given source active, updates Pane 3/2 to its first page, and opens its first question in the editor.
// { skipAutoSelect: true } skips that last auto-select step — used when the caller (e.g. the term-panel
// flows in editor-render.js) is about to call setActiveCard itself with a specific target question, so
// Pane 1/2/3 don't render twice in a row for the same source switch.
function openSource(sourceId, { skipAutoSelect = false } = {}) {
  const source = state.sources.find(s => s.id === sourceId);
  if (!source) return;

  state.activeSourceId = sourceId;
  // Clears the term search box on source switch; the term-scope preference itself is left untouched.
  resetTermSearchOnSourceSwitch();
  renderSourceList(); // updates which card shows the "active" styling

  setupNavRange();
  renderDocPage(1);
  renderTextVersion();

  if (skipAutoSelect) return;

  // Questions are already sourcePage-sorted within a source, so the first match is the earliest page.
  const firstQuestion = state.questions.find(q => q.sourceId === sourceId);
  if (firstQuestion) setActiveCard(firstQuestion.id);
}

// Thumbnail render width: 2x the ~64px CSS display size, for a crisper result on high-DPI screens.
const THUMBNAIL_TARGET_WIDTH = 128;

// Lazily generates and caches a source's stack thumbnail (PDF render, PPTX Tier 1/2, or a failure badge) for reuse on later redraws.
function ensureSourceThumbnail(source) {
  if (source.thumbnailDataUrl || source.thumbnailEl || source.thumbnailFailed || source._thumbnailPromise) return;

  source._thumbnailPromise = (async () => {
    let result = null;
    if (source.docType === 'pdf') {
      const dataUrl = await generatePdfThumbnail(source);
      result = dataUrl ? { kind: 'dataUrl', value: dataUrl } : null;
    } else if (source.docType === 'pptx') {
      result = await generatePptxThumbnail(source);
    }
    source._thumbnailPromise = null;
    if (result && result.kind === 'element') {
      source.thumbnailEl = result.value;
    } else if (result && result.kind === 'dataUrl') {
      source.thumbnailDataUrl = result.value;
    } else {
      source.thumbnailFailed = true;
    }
    renderSourceList(); // swap the loading placeholder for the real thumbnail (or the failure badge)
  })();
}

// Renders this source's first PDF page to a small thumbnail data URL, independent of whichever source is currently active.
async function generatePdfThumbnail(source) {
  if (!source.pdfDoc) return null;
  try {
    const firstPageNumber = source.pages[0] ? source.pages[0].pageNumber : 1;
    return await renderPdfPageToDataUrl(source.pdfDoc, firstPageNumber, THUMBNAIL_TARGET_WIDTH);
  } catch (e) {
    console.error('[main] PDF thumbnail render failed:', e);
    return null;
  }
}

// Generates a PPTX thumbnail: tries a real Tier 1 render first, falling back to Tier 2 embedded-image extraction.
async function generatePptxThumbnail(source) {
  if (source.pptxFile) {
    try {
      const tier1El = await renderPptxTier1Thumbnail(source.pptxFile, source.pages[0] ? source.pages[0].pageNumber : 1, THUMBNAIL_TARGET_WIDTH);
      if (tier1El) return { kind: 'element', value: tier1El };
    } catch (e) {
      console.error('[main] PPTX Tier 1 thumbnail failed, falling back to Tier 2:', e);
    }
  }
  if (!source.pptxZip) return null;
  const firstPageNumber = source.pages[0] ? source.pages[0].pageNumber : 1;
  const tier2Url = await getPptxThumbnailDataUrl(source.pptxZip, firstPageNumber);
  return tier2Url ? { kind: 'dataUrl', value: tier2Url } : null;
}

// Renders the draggable source stack: thumbnail, filename, and question count per source, highlighting the active one.
function renderSourceList() {
  if (!sourceListEl) return;
  sourceListEl.innerHTML = '';
  if (state.sources.length === 0) {
    sourceListEl.classList.add('hidden');
    return;
  }
  sourceListEl.classList.remove('hidden');
  state.sources.forEach((source) => {
    const count = state.questions.filter(q => q.sourceId === source.id).length;
    const row = document.createElement('div');
    row.className = 'source-stack-item' + (source.id === state.activeSourceId ? ' source-stack-item-active' : '');
    row.draggable = true;
    row.dataset.sourceId = source.id;

    // Shows the cached thumbnail (rendered element or image), a loading placeholder, or a failure badge.
    const thumb = document.createElement('div');
    thumb.className = 'source-stack-thumb';
    if (source.thumbnailEl) {
      // Reuses the cached thumbnail node rather than cloning it, since only one card shows it at a time.
      thumb.appendChild(source.thumbnailEl);
    } else if (source.thumbnailDataUrl) {
      const img = document.createElement('img');
      img.src = source.thumbnailDataUrl;
      img.alt = '';
      thumb.appendChild(img);
    } else if (source.thumbnailFailed) {
      thumb.classList.add('source-stack-thumb-fallback');
      thumb.textContent = source.docType === 'pptx' ? 'SLIDE' : 'PDF';
    } else {
      thumb.classList.add('source-stack-thumb-loading');
      ensureSourceThumbnail(source);
    }
    row.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'source-stack-meta';

    const handle = document.createElement('span');
    handle.className = 'source-stack-handle';
    handle.textContent = '⠿';
    handle.setAttribute('aria-hidden', 'true');
    handle.title = 'Drag to reorder';

    const name = document.createElement('span');
    name.className = 'source-list-name';
    name.textContent = source.name;
    name.title = 'Double-click to rename';
    // stopPropagation keeps the double-click from also reaching openSource() via the row's click delegation
    // below (the delegated handler already excludes .source-list-name, but this keeps the intent local too).
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRenamingSource(source, name);
    });

    const countEl = document.createElement('span');
    countEl.className = 'source-list-count';
    countEl.textContent = count;

    meta.appendChild(handle);
    meta.appendChild(name);
    meta.appendChild(countEl);
    row.appendChild(meta);

    sourceListEl.appendChild(row);
  });
}

// Swaps a source-stack row's name span for a text input so the source can be renamed in place.
// Commits on blur or Enter; Escape or an emptied field discards the edit and restores the previous name.
function startRenamingSource(source, nameEl) {
  const previousName = source.name;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'source-list-name-input';
  input.value = previousName;
  // Keeps clicks/drags inside the input from bubbling to the row's click (openSource) or drag handlers.
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('mousedown', (e) => e.stopPropagation());

  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    const typed = input.value.trim();
    source.name = typed || previousName; // guard against an emptied field
    renderSourceList();
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    renderSourceList(); // no state change — just redraw the row back to its display state
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });

  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

// Native HTML5 drag-and-drop reordering for the stack above, delegated on sourceListEl since rows are rebuilt on each render.
let dragSourceRowId = null;

if (sourceListEl) {
  // Opens the clicked source, ignoring clicks on the drag handle and on the name (single-click there is
  // reserved for cursor placement/selection ahead of a rename; double-click on it starts the rename itself).
  sourceListEl.addEventListener('click', (e) => {
    if (e.target.closest('.source-stack-handle, .source-list-name, .source-list-name-input')) return;
    const row = e.target.closest('.source-stack-item');
    if (!row) return;
    openSource(row.dataset.sourceId);
  });

  sourceListEl.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.source-stack-item');
    if (!row) return;
    dragSourceRowId = row.dataset.sourceId;
    row.classList.add('source-stack-item-dragging');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });

  sourceListEl.addEventListener('dragend', (e) => {
    const row = e.target.closest('.source-stack-item');
    if (row) row.classList.remove('source-stack-item-dragging');
    dragSourceRowId = null;
  });

  sourceListEl.addEventListener('dragover', (e) => {
    e.preventDefault(); // required for this element to accept a drop at all
    const overRow = e.target.closest('.source-stack-item');
    const draggingRow = sourceListEl.querySelector('.source-stack-item-dragging');
    if (!overRow || !draggingRow || overRow === draggingRow) return;
    const rect = overRow.getBoundingClientRect();
    const insertBefore = (e.clientY - rect.top) < rect.height / 2;
    sourceListEl.insertBefore(draggingRow, insertBefore ? overRow : overRow.nextSibling);
  });

  sourceListEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragSourceRowId) return;
    const orderedIds = Array.from(sourceListEl.querySelectorAll('.source-stack-item')).map(el => el.dataset.sourceId);
    state.sources.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
    sortQuestionsByPage();
    renderQuestionNav();
    renderSourceList();
  });
}

registerSourceSwitcher(openSource);

renderTextVersion();
addQuestion();