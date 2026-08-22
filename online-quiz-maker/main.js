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
import { renderPptxTier1Thumbnail, getPptxThumbnailDataUrl } from './pptx-render.js';
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

// Expands/collapses the source panel column. Width-only: the class is toggled on both #sourcePane (styles.css
// keys the collapsed thumb-only row layout off it) and #layoutRoot (keys the grid-template-columns width off
// it, scoped to the same lg breakpoint the column widths were already defined at) so nothing about row height
// or the panel's vertical layout changes. Batch #4's drag-resize work can replace this later without touching
// the collapsed/expanded CSS itself.
if (sourcePanelToggleBtn && sourcePaneEl) {
  sourcePanelToggleBtn.addEventListener('click', () => {
    const expanded = sourcePaneEl.classList.toggle('source-panel-expanded');
    if (layoutRootEl) layoutRootEl.classList.toggle('source-panel-expanded', expanded);
    sourcePanelToggleBtn.setAttribute('aria-expanded', String(expanded));
    sourcePanelToggleBtn.title = expanded ? 'Collapse source panel' : 'Expand source panel';
  });
}

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

// Lets editor-render.js's term-panel handlers (filterByTerm, viewFlaggedQuestion) trigger a full
// source switch — same dependency direction as resetTermSearchOnSourceSwitch, just the opposite way.
registerSourceSwitcher(openSource);

// ---------- Init ----------
renderTextVersion();
addQuestion();
