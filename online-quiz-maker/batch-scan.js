// batch-scan.js
// Extracted verbatim from online-quiz-maker.html, source lines 4808-4939
// (module [16] per MODULARIZATION_SCHEMA.txt): applyPreferredQuestionType,
// scanPageRange, openScanRangeModal, closeScanRangeModal, plus the
// event-wiring for the Scan Pages modal and the Pane 3 "Scan This Page"
// shortcut (moved with handler, per the schema's "move with handler"
// strategy — none of the listener callback bodies were altered).
// Function bodies are UNCHANGED from source — only import/export wrapper
// lines were added.
//
// SOURCE LINE RANGES (in original file order):
//   4808-4819  applyPreferredQuestionType
//   4831-4846  scanPageRange
//   4848-4875  openScanRangeModal
//   4876       closeScanRangeModal
//   4878-4918  scanRangeBtn/closeScanRangeModalBtn/scanRangeModal/
//              scanRangeGenerateBtn listeners (moved with handler)
//   4925-4939  scanCurrentPageBtn listener (moved with handler)
//
// FLAGGED (not moved here, not part of this module): source lines
// 4941-4944, the final `renderTextVersion(); addQuestion();` init block
// that closes out the file's IIFE — per the schema's own SHARED CONTEXT
// note, this stays in the main orchestrator and runs after every module
// is loaded, not in any one module.

// --- Shared dependencies ---
import { state } from './core-state.js';
import {
  scanRangeError,
  scanRangeStatus,
  scanRangeHint,
  scanSourceSelect,
  scanSourceFieldEl,
  scanFromPage,
  scanToPage,
  scanRangeGenerateBtn,
  scanRangeModal,
  scanRangeBtn,
  closeScanRangeModalBtn,
  scanQuestionType,
  parseStatus,
  scanCurrentPageBtn,
  scanCurrentPageType,
} from './dom-refs.js';
import { setParseStatus } from './status-helpers.js';

// Functions from other modules that these functions call:
import { generateSingleVariant } from './variant-generation.js';
import { collectTargetTerms } from './ai-prompt-builders.js';
import { generateQuestionsWithAI } from './ai-api-calls.js';
import { sortQuestionsByPage, updateQuestionCount } from './question-model.js';
import { renderTextVersion } from './layout-formatting.js';
import { renderQuestionNav, setActiveCard } from './editor-render.js';

// Every "question collection" always needs its Multiple Choice (clamp)
// base variant first — the bulk 3-pass pipeline and the single-snippet
// generator both only ever produce that. When the person has picked a
// specific question type from one of the "type of question" dropdowns
// (scan modal, "Scan This Page", or the selection-highlight toolbar),
// this generates ONE additional variant of that type for each newly
// created question and makes it the active tab, so what they land on
// matches what they asked for — while the required MC base stays
// underneath it, still reachable from its own tab. 'mixed' (AI decides)
// and 'clamp' (Multiple Choice, already the base) are no-ops here.
// Best-effort per question — a single failure doesn't block the batch;
// that question just falls back to showing its MC base.
// ---------------------------------------------------------------------
// Verbatim from source, lines 4808-4819
// ---------------------------------------------------------------------
async function applyPreferredQuestionType(questions, type) {
  if (!type || type === 'mixed' || type === 'clamp') return;
  for (const q of questions) {
    try {
      const variant = await generateSingleVariant(q, type);
      q.variants.push(variant);
      q.activeVariantIndex = q.variants.length - 1;
    } catch (err) {
      console.error(err);
    }
  }
}

// =====================================================================
// Scan Page Range: runs the same 3-pass AI pipeline as the initial
// import, but scoped to just the page(s) the user picks — new
// questions are appended to state.questions rather than replacing it.
// Shared by the "Scan Pages" modal and the Pane 3 "Scan This Page"
// shortcut below, so both stay in sync with one implementation.
// `questionType` (optional, 'mixed' | 'clamp' | 'true_false' |
// 'category') comes from either shortcut's "type of question" dropdown
// — see applyPreferredQuestionType above.
// =====================================================================
// ---------------------------------------------------------------------
// Verbatim from source, lines 4831-4846
// ---------------------------------------------------------------------
async function scanPageRange(from, to, questionType) {
  const rangePages = state.pages.filter(p => p.pageNumber >= from && p.pageNumber <= to);
  if (rangePages.length === 0) throw new Error('No pages in that range.');

  const seedTerms = collectTargetTerms(state.questions);
  const generated = await generateQuestionsWithAI(rangePages, seedTerms);
  await applyPreferredQuestionType(generated, questionType);

  state.questions = state.questions.concat(generated);
  sortQuestionsByPage();
  updateQuestionCount();
  renderTextVersion();
  renderQuestionNav();
  setActiveCard(generated[0].id);
  return generated;
}

// UPDATE 2B (new, not from source — see UI_UPGRADES_HANDOFF_PROMPT.md,
// Update 2B item 4): which source the modal's from/to bounds should be
// computed against — whichever one is picked in scanSourceSelect, or
// the active source if the picker is hidden (0-1 sources, or the ref
// wasn't found for some reason). Kept separate from state.activeSourceId
// itself so opening the modal / changing the picker never silently
// switches what Pane 2/3 are showing — only actually clicking "Scan →"
// does that (see the scanRangeGenerateBtn listener below), and only
// because it has to (see that listener's own note on why).
function getScanTargetSourceId() {
  if (scanSourceSelect && state.sources.length > 1 && scanSourceSelect.value) return scanSourceSelect.value;
  return state.activeSourceId;
}
function getScanTargetPages() {
  const source = state.sources.find(s => s.id === getScanTargetSourceId());
  // Falls back to the (shimmed) state.pages for the pre-multi-source
  // edge case: no source exists yet at all, so `source` above is
  // undefined and state.pages itself already correctly returns [].
  return source ? source.pages : state.pages;
}

// UPDATE 2B (new, not from source): populates the picker from
// state.sources, defaulting to whichever source is currently active in
// Pane 3. Hidden whenever there's 0 or 1 imported sources — with only
// one possible choice, the picker is just noise, same rationale as
// 2A's placeholder source list only showing once there's more than one
// import. Built with DOM APIs (not innerHTML) so a filename with
// HTML-special characters can't be misinterpreted as markup — same
// convention main.js's renderSourceList() already uses.
function populateScanSourcePicker() {
  if (!scanSourceSelect) return;
  scanSourceSelect.innerHTML = '';
  if (state.sources.length <= 1) {
    if (scanSourceFieldEl) scanSourceFieldEl.classList.add('hidden');
    return;
  }
  if (scanSourceFieldEl) scanSourceFieldEl.classList.remove('hidden');
  state.sources.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    if (s.id === state.activeSourceId) opt.selected = true;
    scanSourceSelect.appendChild(opt);
  });
}

// UPDATE 2B: the from/to bounds + hint text, split out of
// openScanRangeModal() (below) so scanSourceSelect's own 'change'
// listener can re-run just this part when the picked document changes,
// without re-populating the picker itself or touching the error/status
// banners. Reads whichever source getScanTargetPages() resolves to —
// NOT always state.pages (which is only ever the active source) — so
// switching the picker updates these bounds even for a source that
// isn't currently shown in Pane 3.
// ---------------------------------------------------------------------
// Verbatim from source, lines 4848-4875, EXCEPT reading
// getScanTargetPages() instead of always state.pages — see note above.
// ---------------------------------------------------------------------
function refreshScanRangeBounds() {
  const pages = getScanTargetPages();
  if (pages.length === 0) {
    scanRangeHint.textContent = 'Import a document first.';
    scanFromPage.disabled = true;
    scanToPage.disabled = true;
    scanRangeGenerateBtn.disabled = true;
  } else {
    const first = pages[0].pageNumber;
    const last = pages[pages.length - 1].pageNumber;
    scanFromPage.min = first;
    scanFromPage.max = last;
    scanToPage.min = first;
    scanToPage.max = last;
    // Default to the page currently open in Pane 3, so "rescan this
    // page" is a single click from wherever the user is looking. Only
    // meaningful when the picked source IS the active one — clamps
    // against ITS OWN first/last either way, so a differently-sized
    // non-active source never ends up with an out-of-range default.
    const current = Math.min(Math.max(first, state.currentPage || first), last);
    scanFromPage.value = current;
    scanToPage.value = current;
    scanRangeHint.textContent = `Document has pages ${first}–${last}.`;
    scanFromPage.disabled = false;
    scanToPage.disabled = false;
    scanRangeGenerateBtn.disabled = false;
  }
}
if (scanSourceSelect) scanSourceSelect.addEventListener('change', refreshScanRangeBounds);

function openScanRangeModal() {
  scanRangeError.classList.add('hidden');
  scanRangeStatus.classList.add('hidden');

  populateScanSourcePicker();
  refreshScanRangeBounds();

  scanRangeModal.classList.remove('hidden');
}
// ---------------------------------------------------------------------
// Verbatim from source, line 4876
// ---------------------------------------------------------------------
function closeScanRangeModal() { scanRangeModal.classList.add('hidden'); }

// ---------------------------------------------------------------------
// Verbatim from source, lines 4878-4918 (event wiring that belongs to
// this module's own functions — moved with handler per the schema's
// strategy. NOT altered.)
// ---------------------------------------------------------------------
scanRangeBtn.addEventListener('click', openScanRangeModal);
closeScanRangeModalBtn.addEventListener('click', closeScanRangeModal);
scanRangeModal.addEventListener('click', (e) => { if (e.target === scanRangeModal) closeScanRangeModal(); });

scanRangeGenerateBtn.addEventListener('click', async () => {
  scanRangeError.classList.add('hidden');
  scanRangeStatus.classList.add('hidden');

  let from = parseInt(scanFromPage.value, 10);
  let to = parseInt(scanToPage.value, 10);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    scanRangeError.textContent = 'Enter a valid page (or page range) to scan.';
    scanRangeError.classList.remove('hidden');
    return;
  }
  if (from > to) { const t = from; from = to; to = t; }

  // UPDATE 2B (see item 4 in the handoff doc): if the picked document
  // isn't the active one, make it active before scanning. This is
  // required, not just convenient — ai-api-calls.js's question-builder
  // touch point (added in 2A, out of scope to change this session)
  // tags every generated question with state.activeSourceId at the
  // moment it's created, so scanning without switching first would tag
  // the new questions with the WRONG source. One side effect worth
  // flagging explicitly rather than leaving implicit: this makes Pane 2
  // correctly redraw for the scanned source afterward (scanPageRange's
  // own renderTextVersion() call, further down, picks it up
  // automatically via the shim) — but Pane 3's canvas/slide view is
  // NOT re-synced here (that's setupNavRange()/renderDocPage(), in
  // doc-pane-navigation.js, which isn't among the files sent for 2B),
  // so Pane 3 can end up showing a stale page — or, if the scanned
  // source is a different docType than what was previously active, the
  // wrong preview element entirely — until the person next navigates
  // Pane 3 themselves. Left as a known follow-up rather than guessed
  // at blind, since fixing it correctly needs that file's internals.
  const targetSourceId = getScanTargetSourceId();
  if (targetSourceId && targetSourceId !== state.activeSourceId) {
    state.activeSourceId = targetSourceId;
  }

  scanRangeGenerateBtn.disabled = true;
  const rangeLabel = from === to ? `page ${from}` : `pages ${from}–${to}`;
  scanRangeStatus.textContent = `Scanning ${rangeLabel}…`;
  scanRangeStatus.classList.remove('hidden');
  const priorParseStatus = parseStatus.textContent;
  // Reuse setParseStatus so the 3-pass progress messages ("Pass 1 of
  // 3 — …") surface in the modal too, then restore whatever Pane 1
  // was showing before once this scan finishes.
  const restoreStatus = () => { setParseStatus(priorParseStatus || '', 'idle'); };

  try {
    const generated = await scanPageRange(from, to, scanQuestionType.value);
    scanRangeStatus.textContent = `Added ${generated.length} question${generated.length === 1 ? '' : 's'} from ${rangeLabel}.`;
    scanRangeStatus.classList.remove('hidden');
  } catch (err) {
    console.error(err);
    scanRangeError.textContent = err.message || `Failed to scan ${rangeLabel}.`;
    scanRangeError.classList.remove('hidden');
    scanRangeStatus.classList.add('hidden');
  } finally {
    scanRangeGenerateBtn.disabled = false;
    restoreStatus();
  }
});

// "Scan This Page" — a one-click shortcut in Pane 3 that scans
// whatever page is currently active there (state.currentPage),
// without opening the range modal. Reports progress/results through
// Pane 1's parseStatus line since there's no dedicated status area
// next to this button.
// ---------------------------------------------------------------------
// Verbatim from source, lines 4925-4939
// ---------------------------------------------------------------------
scanCurrentPageBtn.addEventListener('click', async () => {
  if (state.pages.length === 0) return;
  const page = state.currentPage;
  scanCurrentPageBtn.disabled = true;
  setParseStatus(`Scanning page ${page}…`);
  try {
    const generated = await scanPageRange(page, page, scanCurrentPageType.value);
    setParseStatus(`Added ${generated.length} question${generated.length === 1 ? '' : 's'} from page ${page}.`, 'success');
  } catch (err) {
    console.error(err);
    setParseStatus(err.message || `Failed to scan page ${page}.`, 'error');
  } finally {
    scanCurrentPageBtn.disabled = false;
  }
});

export {
  applyPreferredQuestionType,
  scanPageRange,
  openScanRangeModal,
  closeScanRangeModal,
};
