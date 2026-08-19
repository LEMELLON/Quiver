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

// generates one variant of the given type for each question and makes it active; no-op for 'mixed'/'clamp'
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

// runs the 3-pass AI pipeline scoped to a page range and appends the results to state.questions
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

// which source the scan modal's from/to bounds should be computed against
function getScanTargetSourceId() {
  if (scanSourceSelect && state.sources.length > 1 && scanSourceSelect.value) return scanSourceSelect.value;
  return state.activeSourceId;
}
function getScanTargetPages() {
  const source = state.sources.find(s => s.id === getScanTargetSourceId());
  return source ? source.pages : state.pages;
}

// populates the scan-source picker from state.sources; hidden when there's 0 or 1 imported sources
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

// refreshes the from/to page bounds and hint text for whichever source is targeted
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
    // Defaults to the page currently open in Pane 3, clamped to this source's own range.
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
function closeScanRangeModal() { scanRangeModal.classList.add('hidden'); }

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

  // Switch active source to the scan target first, since generated questions are tagged with
  // state.activeSourceId at creation time. Note: Pane 3 is not re-synced here (known follow-up).
  const targetSourceId = getScanTargetSourceId();
  if (targetSourceId && targetSourceId !== state.activeSourceId) {
    state.activeSourceId = targetSourceId;
  }

  scanRangeGenerateBtn.disabled = true;
  const rangeLabel = from === to ? `page ${from}` : `pages ${from}–${to}`;
  scanRangeStatus.textContent = `Scanning ${rangeLabel}…`;
  scanRangeStatus.classList.remove('hidden');
  const priorParseStatus = parseStatus.textContent;
  // Reuse setParseStatus so 3-pass progress messages surface in the modal too, then restore the prior status.
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

// one-click shortcut to scan whatever page is currently active in Pane 3; reports progress via Pane 1's status line
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
