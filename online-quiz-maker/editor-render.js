// --- Shared state / DOM refs ---
import { state, getDuplicateMap, setDuplicateMap } from './core-state.js';
import {
  questionNavGroup,
  questionNavEl,
  questionNavPager,
  activeEditorEl,
  emptyState,
  pane3QuestionNavEl,
  docTextContainer,
  addQuestionBtn,
  removeDuplicatesBtn,
  termBarEl,
  termFilterIndicatorEl,
  termScopeToggleEl,
  termSearchInputEl,
} from './dom-refs.js';

import { normalizeTermKeyLoose } from './text-normalize.js';
import { TIER_META, DATA_STATUS_META } from './classification-meta.js';
import { MIN_CHOICES, AUTO_SYNC_ENABLED } from './shared-constants.js';

// Functions from other modules that these functions/handlers call:
import { computeDuplicateMap, computeDataClassification, deleteQuestion, isContainedIn,
         removeVariant, sortQuestionsByPage, addQuestion,
         removeFlaggedDuplicates, duplicateQuestion } from './question-model.js';
// renderTextVersion is only called inside the duplicate click handler, never at module-evaluation time, so the import cycle is safe.
import { renderTextVersion } from './layout-formatting.js';
import { renderDocPage } from './doc-pane-navigation.js';
import { onSnippetRelevantEdit, handleScanField, handleScanAnswerOutside,
         startSnippetEdit, saveSnippetEdit, cancelSnippetEdit } from './snippet-question-generation.js';
import { handleGenerateVariant, handleRegenerateChoices } from './variant-generation.js';
// markQidList reads a mark's data-qid, which may hold more than one id (a shared duplicate-pair mark).
import { markQidList } from './highlighting.js';
// Field sync (Batch 4): sync-state for the derived target term / clamp question text, plus the Sync / Keep mine actions.
import { getFieldSyncState, getUnderivableReason, getQuestionDerivationMode, getVerbatimReason, applyFieldSync, keepFieldAsIs, getClampVariant } from './field-sync.js';

// Injected by main.js (registerSourceSwitcher) so term-panel handlers can trigger a full source switch
// (state.activeSourceId update, pane re-renders, etc.) without editor-render.js importing main.js back.
let switchActiveSource = null;
function registerSourceSwitcher(fn) { switchActiveSource = fn; }

// Escapes HTML-unsafe characters for safe interpolation into markup/attributes.
function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

// =====================================================================
// PANE 1 — question nav chips + the single "active" editor
// =====================================================================

// Paginated nav-chip bar: caps the visible window and adds a numbered pager (see renderQuestionNav/buildPagerHtml).
const NAV_CHIPS_PER_PAGE = 20;
const NAV_PAGER_BLOCK_SIZE = 10; // numbered page buttons shown per block before Next steps to the next block
let navChipPage = 0;

// Normalized term key the chip grid is currently filtered to (normalizeTermKeyLoose key), or null when unfiltered.
let activeTermFilterKey = null;

// Which questions the term panel draws its visible rows from: 'all', 'source' (active source, any page), or 'page' (active source's current page). Persists across source switches.
let termScopeMode = 'all'; // 'all' | 'source' | 'page'

// Live search text for the term panel, matched case-insensitively against each term group's label; resets on source switch.
let termSearchQuery = '';

// Questions visible in the Pane 1 chip list — scoped to the active source (or no sourceId) and any active term filter — paired with their stable index in state.questions.
function visibleQuestionEntries() {
  return state.questions
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => q.sourceId === state.activeSourceId || q.sourceId == null)
    .filter(({ q }) => !activeTermFilterKey || normalizeTermKeyLoose(q.targetTerm || '') === activeTermFilterKey);
}

// Every question belonging to `sourceId`, plus any question with no sourceId at all. Not filtered by activeTermFilterKey, so display numbering stays stable regardless of any term filter.
function sourceScopedEntries(sourceId) {
  return state.questions
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => q.sourceId === sourceId || q.sourceId == null);
}

// The 0-based per-source display number for a question (what buildNavChipHtml renders as Q01/Q02/...), computed from q's own sourceId so it's correct even for a non-active source.
function perSourceDisplayIndex(q) {
  return sourceScopedEntries(q.sourceId).findIndex(({ q: eq }) => eq.id === q.id);
}

function totalNavChipPages() {
  return Math.max(1, Math.ceil(visibleQuestionEntries().length / NAV_CHIPS_PER_PAGE));
}

// Builds the numbered-page + Prev/Next controls; returns '' when everything fits on one page.
function buildPagerHtml() {
  const totalPages = totalNavChipPages();
  if (totalPages <= 1) return '';

  const blockStart = Math.floor(navChipPage / NAV_PAGER_BLOCK_SIZE) * NAV_PAGER_BLOCK_SIZE;
  const blockEnd = Math.min(blockStart + NAV_PAGER_BLOCK_SIZE, totalPages);
  const prevDisabled = navChipPage === 0;
  const nextDisabled = navChipPage === totalPages - 1;

  let html = `<button type="button" class="nav-pager-arrow" data-page-goto="${navChipPage - 1}" ${prevDisabled ? 'disabled' : ''} aria-label="Previous page">‹ Prev</button>`;
  for (let i = blockStart; i < blockEnd; i++) {
    html += `<button type="button" class="nav-pager-btn ${i === navChipPage ? 'nav-pager-btn-active' : ''}" data-page-goto="${i}">${i + 1}</button>`;
  }
  html += `<button type="button" class="nav-pager-arrow" data-page-goto="${navChipPage + 1}" ${nextDisabled ? 'disabled' : ''} aria-label="Next page">Next ›</button>`;
  return html;
}

// Re-focuses the pager button for the current page after a re-render replaces the pager's DOM (which drops focus).
function focusActiveNavPagerButton() {
  const btn = questionNavPager.querySelector('.nav-pager-btn-active');
  if (btn) btn.focus();
}

// Resolves a duplicate match's display label for the given question, naming the other file for a cross-source match. Returns null if the matched question no longer exists.
function resolveDuplicateMatchLabel(q, dup) {
  const matchQ = state.questions.find(x => x.id === dup.matchId);
  if (!matchQ) return null;
  const num = `Q${String(perSourceDisplayIndex(matchQ) + 1).padStart(2, '0')}`;
  if (matchQ.sourceId === q.sourceId) return { text: num, matchQ };
  const matchSource = state.sources.find(s => s.id === matchQ.sourceId);
  return { text: `${num} in ${matchSource ? matchSource.name : 'another file'}`, matchQ };
}

function buildNavChipHtml(q, displayIndex, dup) {
  const baseTitle = q.targetTerm || (q.variants[0] && q.variants[0].questionText) || 'Untitled question';
  let title = baseTitle;
  if (dup) {
    const resolved = resolveDuplicateMatchLabel(q, dup);
    if (resolved) title = `${baseTitle} — possible duplicate of ${resolved.text} (${dup.reason})`;
    // Matched question was deleted since the map was last computed — fall back to baseTitle.
  }
  return `
    <button type="button" data-nav-id="${q.id}" data-tier="${q.tier || 1}"
      class="nav-chip ${q.id === state.activeCardId ? 'nav-chip-active' : ''} ${q.sourceSnippet ? 'nav-chip-snippet' : ''} ${dup ? 'nav-chip-duplicate' : ''} ${(q.aiUnchecked && !dup) ? 'nav-chip-unchecked' : ''}"
      title="${escapeAttr(title)}">
      Q${String(displayIndex + 1).padStart(2, '0')}
    </button>
  `;
}

// Renders Pane 1's question chip grid (and pager, and dependent panels).
function renderQuestionNav() {
  setDuplicateMap(computeDuplicateMap());

  // Auto-clear the term filter if it no longer matches any question.
  if (activeTermFilterKey && !state.questions.some(q => normalizeTermKeyLoose(q.targetTerm || '') === activeTermFilterKey)) {
    activeTermFilterKey = null;
  }

  // Clamp navChipPage in case the question count shrank since the last render.
  navChipPage = Math.min(Math.max(0, navChipPage), totalNavChipPages() - 1);

  if (state.questions.length === 0) {
    questionNavEl.innerHTML = '';
    questionNavPager.innerHTML = '';
    questionNavPager.classList.add('hidden');
  } else {
    const entries = visibleQuestionEntries();
    if (entries.length === 0) {
      questionNavEl.innerHTML = '<p class="text-xs text-mute italic px-1">No questions match this term filter.</p>';
      questionNavPager.innerHTML = '';
      questionNavPager.classList.add('hidden');
    } else {
      const startIdx = navChipPage * NAV_CHIPS_PER_PAGE;
      const pageItems = entries.slice(startIdx, startIdx + NAV_CHIPS_PER_PAGE);
      questionNavEl.innerHTML = pageItems
        .map(({ q }) => buildNavChipHtml(q, perSourceDisplayIndex(q), getDuplicateMap().get(q.id)))
        .join('');

      const pagerHtml = buildPagerHtml();
      questionNavPager.innerHTML = pagerHtml;
      questionNavPager.classList.toggle('hidden', !pagerHtml);
    }
  }
  renderPane3QuestionNav();
  renderTermBar(); // keep the term panel in sync with every nav-affecting change
}

// Pane 3's own mini nav: every question on the currently-shown source page, using the same Q01/Q02 numbering as Pane 1. Hidden when the page has no questions.
function renderPane3QuestionNav() {
  const chips = [];
  state.questions.forEach((q) => {
    if (q.sourceId !== state.activeSourceId || q.sourcePage !== state.currentPage) return;
    chips.push(buildNavChipHtml(q, perSourceDisplayIndex(q), getDuplicateMap().get(q.id)));
  });
  if (chips.length === 0) {
    pane3QuestionNavEl.innerHTML = '';
    pane3QuestionNavEl.classList.add('hidden');
    return;
  }
  pane3QuestionNavEl.innerHTML = chips.join('');
  pane3QuestionNavEl.classList.remove('hidden');
}
pane3QuestionNavEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-nav-id]');
  if (btn) setActiveCard(btn.dataset.navId);
});

// =====================================================================
// PANE 1 — term nav bar
// =====================================================================

// Does `q` qualify for the "This page" scope — same source and page.
function questionOnActivePage(q) {
  return q.sourceId === state.activeSourceId && q.sourcePage === state.currentPage;
}

// Does `q` qualify for the "This file" scope — same source, any page.
function questionInActiveSource(q) {
  return q.sourceId === state.activeSourceId;
}

// Narrows buildTermGroups()'s full list to what the term panel should render, applying scope and search together. Doesn't affect each group's own "N questions" count, which stays quiz-wide.
function filterTermGroupsForPanel(groups) {
  let visible = groups;
  if (termScopeMode === 'source') {
    visible = visible.filter((g) => g.questionIds.some((qid) => {
      const q = state.questions.find((x) => x.id === qid);
      return q && questionInActiveSource(q);
    }));
  } else if (termScopeMode === 'page') {
    visible = visible.filter((g) => g.questionIds.some((qid) => {
      const q = state.questions.find((x) => x.id === qid);
      return q && questionOnActivePage(q);
    }));
  }
  const query = termSearchQuery.trim().toLowerCase();
  if (query) {
    visible = visible.filter((g) => g.label.toLowerCase().includes(query));
  }
  return visible;
}

// Groups questions with a non-blank targetTerm by normalizeTermKeyLoose() so near-duplicate spellings collapse into one row. `label` is the first-seen raw targetTerm, display-only.
function buildTermGroups() {
  const groups = new Map(); // normalizeTermKeyLoose key -> { key, label, questionIds }
  state.questions.forEach((q) => {
    const raw = (q.targetTerm || '').trim();
    if (!raw) return;
    const key = normalizeTermKeyLoose(raw);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, { key, label: raw, questionIds: [] });
    groups.get(key).questionIds.push(q.id);
  });
  return Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label));
}

// One term row: nav-chip-style duplicate styling (red border + ⚠ prefix, ×N if more than one flagged question), with hover-only view/dismiss icon actions per flagged question.
function buildTermRowHtml(group) {
  const isActive = group.key === activeTermFilterKey;
  const dupQids = group.questionIds.filter((qid) => getDuplicateMap().has(qid));
  const isDuplicate = dupQids.length > 0;
  const dupFlag = isDuplicate ? `⚠${dupQids.length > 1 ? ` ×${dupQids.length}` : ''}` : '';
  return `
    <div class="term-row ${isActive ? 'term-row-active' : ''} ${isDuplicate ? 'term-row-duplicate' : ''}">
      <button type="button" data-action="filterByTerm" data-term-key="${escapeAttr(group.key)}"
        class="term-row-btn" title="Show only questions using this term">
        <span class="term-row-label">${isDuplicate ? `<span class="term-row-dupe-flag">${dupFlag}</span>` : ''}${escapeHtml(group.label)}</span>
        <span class="term-row-count">${group.questionIds.length}</span>
      </button>
      ${isDuplicate ? `
      <div class="term-row-dupe-actions" role="group" aria-label="Duplicate question actions">
        ${dupQids.map((qid) => {
          const dup = getDuplicateMap().get(qid);
          const idx = state.questions.findIndex((x) => x.id === qid);
          const qLabel = `Q${String(idx + 1).padStart(2, '0')} possible duplicate — ${escapeAttr(dup.reason)}`;
          return `
          <button type="button" data-action="viewFlaggedQuestion" data-qid="${qid}" class="term-row-dupe-icon-btn" title="View ${qLabel}">→</button>
          <button type="button" data-action="dismissDuplicateInline" data-qid="${qid}" class="term-row-dupe-icon-btn" title="Not a duplicate — ${qLabel}">✕</button>`;
        }).join('')}
      </div>` : ''}
    </div>
  `;
}

// Renders the term list plus the "showing filtered term" indicator strip. Called from renderQuestionNav() so it tracks every question-list change. Pane 3's mini-nav is deliberately not filtered by activeTermFilterKey.
function renderTermBar() {
  const groups = buildTermGroups();

  // Reflect which scope button is active, read from termScopeMode.
  if (termScopeToggleEl) {
    termScopeToggleEl.querySelectorAll('[data-term-scope]').forEach((btn) => {
      btn.classList.toggle('term-scope-btn-active', btn.dataset.termScope === termScopeMode);
    });
  }

  // Distinguishes "no terms at all" from "terms exist but none match the current scope/search".
  const visibleGroups = filterTermGroupsForPanel(groups);
  termBarEl.innerHTML = visibleGroups.length
    ? visibleGroups.map(buildTermRowHtml).join('')
    : groups.length
      ? '<p class="text-xs text-mute italic">No terms match the current filter.</p>'
      : '<p class="text-xs text-mute italic">No target terms yet — they show up here once questions have one set.</p>';

  termFilterIndicatorEl.classList.toggle('hidden', !activeTermFilterKey);
  if (activeTermFilterKey) {
    const activeGroup = groups.find((g) => g.key === activeTermFilterKey);
    const label = activeGroup ? activeGroup.label : activeTermFilterKey;
    termFilterIndicatorEl.innerHTML = `
      <div class="term-filter-indicator-inner">
        <span>Showing questions for <strong>${escapeHtml(label)}</strong></span>
        <button type="button" data-action="clearTermFilter" class="term-filter-clear">✕ Clear filter</button>
      </div>
    `;
  }
}

// Delegated click handling for the term panel: filtering the chip grid below, jumping to a flagged duplicate, or dismissing its warning.
termBarEl.addEventListener('click', (e) => {
  const filterBtn = e.target.closest('[data-action="filterByTerm"]');
  if (filterBtn) {
    const key = filterBtn.dataset.termKey;
    // Clicking the already-active term again clears the filter (toggle behavior).
    const nextKey = (activeTermFilterKey === key) ? null : key;
    if (nextKey && switchActiveSource) {
      const group = buildTermGroups().find((g) => g.key === nextKey);
      const matchesActiveSource = group && group.questionIds.some((qid) => {
        const q = state.questions.find((x) => x.id === qid);
        return q && q.sourceId === state.activeSourceId;
      });
      if (group && !matchesActiveSource) {
        // None of this term's matches are in the active source — switch to the first match's
        // source (existing page-sort order) before applying the filter, so the switch happens
        // before the filter/re-render rather than after.
        const target = group.questionIds
          .map((qid) => state.questions.find((x) => x.id === qid))
          .find((q) => q);
        if (target) switchActiveSource(target.sourceId);
      }
    }
    activeTermFilterKey = nextKey;
    navChipPage = 0;
    renderQuestionNav();
    return;
  }
  const viewBtn = e.target.closest('[data-action="viewFlaggedQuestion"]');
  if (viewBtn) {
    const targetQ = state.questions.find((x) => x.id === viewBtn.dataset.qid);
    if (targetQ && targetQ.sourceId !== state.activeSourceId && switchActiveSource) {
      // setActiveCard(viewBtn.dataset.qid) runs right below, so skip openSource's own auto-select
      // of the new source's first question — no point rendering it just to immediately replace it.
      switchActiveSource(targetQ.sourceId, { skipAutoSelect: true });
    }
    setActiveCard(viewBtn.dataset.qid);
    return;
  }
  const dismissBtn = e.target.closest('[data-action="dismissDuplicateInline"]');
  if (dismissBtn) {
    dismissDuplicateForQuestion(dismissBtn.dataset.qid);
    return;
  }
});

termFilterIndicatorEl.addEventListener('click', (e) => {
  const clearBtn = e.target.closest('[data-action="clearTermFilter"]');
  if (!clearBtn) return;
  activeTermFilterKey = null;
  navChipPage = 0;
  renderQuestionNav();
});

// Scope-toggle clicks; re-renders just the term panel, since this scope only affects which term rows show here.
if (termScopeToggleEl) {
  termScopeToggleEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-term-scope]');
    if (!btn) return;
    const mode = btn.dataset.termScope;
    if (mode !== termScopeMode) {
      termScopeMode = mode;
      renderTermBar();
    }
  });
}

// Live search-as-you-type; re-renders just the term panel.
if (termSearchInputEl) {
  termSearchInputEl.addEventListener('input', () => {
    termSearchQuery = termSearchInputEl.value;
    renderTermBar();
  });
}

// Clears the term search box on source switch; leaves termScopeMode unchanged.
function resetTermSearchOnSourceSwitch() {
  termSearchQuery = '';
  if (termSearchInputEl) termSearchInputEl.value = '';
  renderTermBar();
}

// Tab group order is fixed (Multiple Choice, True/False, Category Selection); the "Multiple Choice" tab merges the 'clamp' base variant with any 'rephrased' variations into one tab/control.
const VARIANT_GROUP_META = {
  clamp: { label: 'Multiple Choice' },
  true_false: { label: 'True / False' },
  category: { label: 'Category Selection' },
};
// Maps a variant's own `type` to the tab group it displays under.
const GROUP_OF_TYPE = { clamp: 'clamp', rephrased: 'clamp', true_false: 'true_false', category: 'category' };
// The variant `type` a group's "Generate"/"+ New variation" control should produce (merged Multiple Choice group generates 'rephrased').
const GROUP_GENERATE_TYPE = { clamp: 'rephrased', true_false: 'true_false', category: 'category' };
const GROUP_ORDER = ['clamp', 'true_false', 'category'];

// Every index in state.questions[].variants whose type belongs to the given tab group, in array (creation) order.
function variantIndexesOfGroup(q, group) {
  const out = [];
  q.variants.forEach((v, i) => { if (GROUP_OF_TYPE[v.type] === group) out.push(i); });
  return out;
}

function variantTabsTemplate(q) {
  const activeVariant = q.variants[q.activeVariantIndex];
  const activeGroup = activeVariant ? (GROUP_OF_TYPE[activeVariant.type] || 'clamp') : 'clamp';

  const mainTab = (group) => {
    const idxs = variantIndexesOfGroup(q, group);
    const label = VARIANT_GROUP_META[group].label;
    const genType = GROUP_GENERATE_TYPE[group];

    // Not generated yet — locked, click-to-generate instead of a tab.
    if (idxs.length === 0) {
      const generating = q.generatingType === genType;
      return `
        <button type="button" data-action="generateVariant" data-variant-type="${genType}" ${generating ? 'disabled' : ''}
          title="Generate a ${label} variant with AI"
          class="flex-1 font-mono text-[0.62rem] tracking-wide uppercase px-2 py-1.5 rounded border border-dashed border-edge text-mute hover:border-amber hover:text-amber transition-colors disabled:opacity-60 disabled:cursor-wait disabled:hover:border-edge disabled:hover:text-mute">
          ${generating ? 'Generating…' : `🔒 ${label}`}
        </button>`;
    }

    // Already has 1+ variants — a normal tab that jumps to whichever of this group's variants is active, or its first one.
    const targetIndex = idxs.includes(q.activeVariantIndex) ? q.activeVariantIndex : idxs[0];
    const isActiveGroup = activeGroup === group;
    const countSuffix = idxs.length > 1 ? ` (${idxs.length})` : '';
    return `
      <button type="button" data-action="switchVariant" data-variant-index="${targetIndex}"
        class="flex-1 font-mono text-[0.62rem] tracking-wide uppercase px-2 py-1.5 rounded transition-colors ${
          isActiveGroup
            ? 'bg-amber text-void font-bold'
            : 'text-mute border border-edge hover:border-amber hover:text-amber'
        }">
        ${label}${countSuffix}
      </button>`;
  };

  // Below the main tab row, for the active group: one chip per variation (switch + remove) plus a "+" chip to generate another; any variation can be removed as long as it isn't the question's last remaining one.
  const subRow = (() => {
    const idxs = variantIndexesOfGroup(q, activeGroup);
    if (idxs.length === 0) return '';
    const shortLabel = activeGroup === 'clamp' ? 'MC' : activeGroup === 'true_false' ? 'TF' : 'CS';
    const genType = GROUP_GENERATE_TYPE[activeGroup];
    const generating = q.generatingType === genType;
    return `
      <div class="flex flex-wrap items-center gap-1.5 -mt-2 mb-4">
        ${idxs.map((vi, n) => {
          const removable = q.variants.length > 1;
          return `
          <span class="inline-flex items-center gap-1 rounded border pl-2 pr-1 py-0.5 ${
            vi === q.activeVariantIndex ? 'border-amber text-amber' : 'border-edge text-mute'
          }">
            <button type="button" data-action="switchVariant" data-variant-index="${vi}"
              class="font-mono text-[0.6rem] uppercase tracking-wide">${shortLabel}${n + 1}</button>
            ${removable ? `
            <button type="button" data-action="removeVariant" data-variant-index="${vi}"
              title="Remove this variation"
              class="w-3.5 h-3.5 flex items-center justify-center rounded-full text-[0.6rem] leading-none text-mute hover:text-danger hover:bg-danger/10 transition-colors">✕</button>
            ` : ''}
          </span>
        `;}).join('')}
        <button type="button" data-action="generateVariant" data-variant-type="${genType}" ${generating ? 'disabled' : ''}
          title="Generate another ${VARIANT_GROUP_META[activeGroup].label} variation with AI"
          class="font-mono text-[0.6rem] uppercase tracking-wide px-2 py-0.5 rounded border border-dashed border-edge text-mute hover:border-amber hover:text-amber transition-colors disabled:opacity-60 disabled:cursor-wait">
          ${generating ? '…' : '+ New variation'}
        </button>
      </div>`;
  })();

  return `
    <div class="flex gap-1.5 mb-4 border-b border-edge pb-3">
      ${GROUP_ORDER.map(mainTab).join('')}
    </div>
    ${subRow}
    ${q.variantGenError ? `<p class="text-xs text-danger -mt-2 mb-4">⚠ ${escapeHtml(q.variantGenError)}</p>` : ''}
  `;
}

// Category Selection is checkbox-style (0+ correct answers via correctAnswerIndices); every other type is radio-style (1 correct answer via correctAnswerIndex). Choice count starts at 4 and can grow/shrink to MIN_CHOICES, except true_false which is fixed.
function choiceRowsTemplate(q, variant) {
  const removable = variant.type !== 'true_false' && variant.choices.length > MIN_CHOICES;
  const removeBtn = (i) => removable ? `
        <button type="button" data-action="removeChoice" data-choice-index="${i}"
          title="Remove this choice"
          class="w-6 h-6 shrink-0 flex items-center justify-center rounded text-mute hover:text-danger hover:bg-danger/10 transition-colors">✕</button>` : '';

  if (variant.type === 'category') {
    const correctSet = new Set(variant.correctAnswerIndices || []);
    return variant.choices.map((choice, i) => `
      <div class="flex items-center gap-2">
        <input type="checkbox" data-action="toggleCorrect" data-choice-index="${i}"
          ${correctSet.has(i) ? 'checked' : ''}
          class="w-4 h-4 shrink-0 accent-amber" title="Mark as a correct answer" />
        <input type="text" data-field="choice" data-choice-index="${i}" value="${escapeAttr(choice)}"
          placeholder="Choice ${i + 1}"
          class="input-base ${correctSet.has(i) ? 'ring-1 ring-violet/60 border-violet/60' : ''}" />
        ${removeBtn(i)}
      </div>
    `).join('');
  }
  return variant.choices.map((choice, i) => `
    <div class="flex items-center gap-2">
      <input type="radio" name="correct_${q.id}_${variant.type}" data-action="setCorrect" data-choice-index="${i}"
        ${variant.correctAnswerIndex === i ? 'checked' : ''}
        class="w-4 h-4 shrink-0 accent-amber" title="Mark as correct answer" />
      <input type="text" data-field="choice" data-choice-index="${i}" value="${escapeAttr(choice)}"
        placeholder="Choice ${i + 1}"
        class="input-base ${variant.correctAnswerIndex === i ? 'ring-1 ring-violet/60 border-violet/60' : ''}" />
      ${removeBtn(i)}
    </div>
  `).join('');
}

// Placeholder text per variant type, shown in the question-text textarea.
const VARIANT_PLACEHOLDERS = {
  clamp: 'Sentence-continuation prompt with the term blanked out (e.g. "___ is an electronic machine, operating under the control of instructions...")',
  // Kept for questions loaded from older exported JSON using the retired 'definition' variant type.
  definition: 'Definition-first prompt (e.g. "The restriction of an inmate to a segregated area is called what?")',
  rephrased: 'A differently-worded conceptual or scenario question testing the same term',
  true_false: 'A true/false statement derived from the source material',
  category: 'A "select all that apply" prompt (e.g. "What are the Components of a Computer?")',
};


const BTN_MUTED = 'text-[0.62rem] font-mono uppercase tracking-wide text-mute hover:text-amber transition-colors';

// One of the three snippet panels (source / question / answer). Source is read-only (changed only by scanning);
// question and answer get an inline Edit → textarea → Save/Cancel flow (D9) that commits on Save, not per keystroke.
function snippetPanelTemplate(q, field, tierMeta) {
  const text = field === 'source' ? q.sourceSnippet : field === 'question' ? q.questionSnippet : q.answerSnippet;
  const outsideAnswer = field === 'answer' && q.answerScope === 'outside';
  const editable = field !== 'source';
  const editing = editable && q.editingField === field;

  const labels = {
    source: ['Source snippet', 'subtle outline in Pane 2 · changed only by scanning'],
    question: ['Question snippet', `${tierMeta.label} highlight · inside the source`],
    answer: ['Answer snippet', 'green in Pane 2'],
  }[field];
  const scanTitles = {
    source: "Highlight the broad passage this question is drawn from in the document text (Pane 2), then click here — it replaces the source snippet",
    question: "Highlight the question passage INSIDE the source snippet (Pane 2), then click here",
    answer: "Highlight the exact answer INSIDE the source snippet (Pane 2), then click here",
  }[field];
  const scanLabels = { source: '🔎 Scan source', question: '🔎 Scan question', answer: '🔎 Scan answer' };

  // Warning badges: an 'outside' answer is deliberate; an 'inside' child that no longer fits in the source is a problem.
  let badge = '';
  if (outsideAnswer && text) {
    badge = `<span class="text-[0.6rem] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border border-edge text-amber"
      title="This answer lives outside the source snippet, elsewhere in the same document">Outside source · p.${q.answerPage != null ? q.answerPage : q.sourcePage}</span>`;
  } else if (editable && text && q.sourceSnippet && !isContainedIn(text, q.sourceSnippet)) {
    badge = `<span class="text-[0.6rem] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border border-danger/50 text-danger"
      title="This snippet is not inside the source snippet">⚠ Outside source</span>`;
  }

  const body = editing
    ? `<textarea data-snippet-edit="${field}" rows="3" class="input-base resize-y mt-1">${escapeHtml(q.editDraft)}</textarea>
       <div class="flex items-center gap-3 mt-1.5">
         <button type="button" data-action="saveSnippetEdit" data-field-type="${field}" class="${BTN_MUTED}">Save</button>
         <button type="button" data-action="cancelSnippetEdit" data-field-type="${field}" class="${BTN_MUTED}">Cancel</button>
       </div>`
    : (text
        ? `<p class="text-xs ${field === 'answer' ? 'text-emerald-400/90' : 'text-mute'} italic leading-relaxed">"${escapeHtml(text)}"</p>`
        : `<p class="text-xs text-mute/60 italic">${field === 'source'
            ? 'No source yet — highlight a passage in the document text, then click "Scan source".'
            : `Not yet set — highlight the passage inside the source, then click "Scan ${field}".`}</p>`);

  return `
      <div class="mt-3 pt-3 border-t border-edge" data-snippet-panel="${field}">
        <div class="flex items-center justify-between mb-1 gap-2">
          <label class="field-label mb-0 flex items-center gap-2 flex-wrap">
            <span>${labels[0]} <span class="normal-case text-mute/70">(${labels[1]})</span></span>${badge}
          </label>
          <div class="flex items-center gap-2 shrink-0 ml-2 flex-wrap justify-end">
            ${text ? `<button type="button" data-action="locateSnippet" data-snippet-type="${field}"
              class="text-[0.62rem] font-mono uppercase tracking-wide text-mute hover:text-violet transition-colors">Locate 🔍</button>` : ''}
            ${editable && !editing ? `<button type="button" data-action="editSnippet" data-field-type="${field}" class="${BTN_MUTED}">✎ Edit</button>` : ''}
            <button type="button" data-action="scanField" data-field-type="${field}" title="${escapeAttr(scanTitles)}" class="${BTN_MUTED}">${scanLabels[field]}</button>
            ${field === 'answer' ? `<button type="button" data-action="scanAnswerOutside"
              title="The answer is named elsewhere in this document (e.g. an earlier page): highlight it there, then click here"
              class="${BTN_MUTED}">➕ Answer outside source</button>` : ''}
          </div>
        </div>
        ${body}
      </div>`;
}

// ---------- Field sync row (Batch 4) ----------
// "Field sync" = target term / clamp question text vs. their snippets. Not the dormant AI resync, not Sync Highlights, not syncBadge.
const FIELD_SYNC_TITLE_MAX = 300; // the Sync button's title shows the exact value it will write, truncated past this
const FIELD_SYNC_PAIR_LABEL = { term: 'Answer', question: 'Question' }; // which snippet the pair is out of sync with, for the row text

// Inner HTML of one sync row slot, built from getFieldSyncState(). '' for 'synced' / 'none' (the slot stays an empty, zero-height div),
// except the muted verbatim-mode note for the question pair.
function fieldSyncRowInnerHtml(q, pair) {
  const { state: syncState, derived } = getFieldSyncState(q, pair);
  if (syncState === 'desynced') {
    const title = derived.length > FIELD_SYNC_TITLE_MAX ? derived.slice(0, FIELD_SYNC_TITLE_MAX) + '…' : derived;
    return `
      <div class="field-sync-row field-sync-row-desynced">
        <span class="field-sync-msg">Out of sync with the ${FIELD_SYNC_PAIR_LABEL[pair]} snippet</span>
        <button type="button" data-action="fieldSync" data-pair="${pair}" title="${escapeAttr(title)}" class="${BTN_MUTED}">↻ Sync from snippet</button>
        <button type="button" data-action="fieldSyncKeep" data-pair="${pair}" title="Keep the text as typed and stop flagging it" class="${BTN_MUTED}">Keep mine</button>
      </div>`;
  }
  if (syncState === 'underivable') {
    return `
      <div class="field-sync-row field-sync-row-underivable">
        <span class="field-sync-msg">Can’t derive: ${escapeHtml(getUnderivableReason(q, pair))}</span>
        <button type="button" data-action="fieldSync" data-pair="${pair}" disabled title="Nothing to sync from" class="${BTN_MUTED}">↻ Sync from snippet</button>
        <button type="button" data-action="fieldSyncKeep" data-pair="${pair}" title="Accept the text as typed and stop flagging it" class="${BTN_MUTED}">Keep mine</button>
      </div>`;
  }
  // G5: verbatim mode is not an error. Muted note only while the field really holds the derived (verbatim) text.
  if (pair === 'question' && syncState === 'synced' && derived !== null && getQuestionDerivationMode(q) === 'verbatim') {
    const clamp = getClampVariant(q);
    const squash = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
    if (clamp && squash(clamp.questionText) === squash(derived)) {
      return `<div class="field-sync-note">Using the question snippet as written \u2014 the answer isn\u2019t blanked because ${escapeHtml(getVerbatimReason(q))}.</div>`;
    }
  }
  return '';
}

// The always-present slot under a derived field: the `input` handler patches just this element (data-sync-row) while typing.
function fieldSyncSlotTemplate(q, pair) {
  return `<div class="field-sync-slot" data-sync-row="${pair}">${fieldSyncRowInnerHtml(q, pair)}</div>`;
}

// True when the question-text textarea currently shows the clamp variant that the 'question' pair derives (the only variant ever derived/flagged).
function isDerivedQuestionVariant(q, variant) {
  return !!variant && variant.type === 'clamp' && variant === getClampVariant(q);
}

// Re-renders only the sync row of one pair in place (never the field itself), so the buttons aren't replaced while the person is typing.
function patchFieldSyncRow(q, pair) {
  const slot = activeEditorEl.querySelector(`.question-card[data-id="${q.id}"] [data-sync-row="${pair}"]`);
  if (!slot) return;
  const html = fieldSyncRowInnerHtml(q, pair);
  if (slot.innerHTML.trim() !== html.trim()) slot.innerHTML = html;
}

// Renders the active question's full editor card: status badges, duplicate warning, target term, variant tabs, question text, source/answer snippets, and sync status.
function activeEditorTemplate(q, index, total) {
  const variant = q.variants[q.activeVariantIndex] || q.variants[0];
  const tierMeta = TIER_META[q.tier] || TIER_META[1];
  const dataStatusMeta = DATA_STATUS_META[computeDataClassification(q)];
  const dup = getDuplicateMap().get(q.id);
  return `
    <div class="question-card bg-card border border-edge rounded-lg p-4 lg:p-5 mb-4" data-id="${q.id}">
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-mono text-xs tracking-wider text-amber">Active — Q${String(index + 1).padStart(2, '0')} / ${total}</span>
          <span class="text-[0.6rem] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border"
            style="background-color: ${tierMeta.color}22; color: ${tierMeta.color}; border-color: ${tierMeta.color}55;">
            ${tierMeta.label}
          </span>
          <span class="text-[0.6rem] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border"
            style="background-color: ${dataStatusMeta.color}22; color: ${dataStatusMeta.color}; border-color: ${dataStatusMeta.color}55;"
            title="Data classification: Unclassified = source, question or answer snippet missing · Unverified = all present but one couldn't be highlighted or falls outside its source · Verified = all three present, highlighted and consistent">
            ${dataStatusMeta.label}
          </span>
          ${q.definitionType === 'extension' ? `
          <span class="text-[0.6rem] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border border-edge text-mute">Extension</span>
          ` : ''}
          ${(q.aiUnchecked && !dup) ? `
          <span class="text-[0.6rem] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border"
            style="background-color: #22c55e22; color: #22c55e; border-color: #22c55e55;"
            title="AI-autogenerated — not yet reviewed">Unchecked</span>
          ` : ''}
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button type="button" data-action="duplicate" title="Duplicate this question (copy with all snippets and variants)"
            class="w-7 h-7 flex items-center justify-center rounded text-mute hover:text-amber hover:bg-amber/10 transition-colors">⧉</button>
          <button type="button" data-action="delete" title="Delete question collection"
            class="w-7 h-7 flex items-center justify-center rounded text-mute hover:text-danger hover:bg-danger/10 transition-colors">✕</button>
        </div>
      </div>

      ${(() => {
        if (!dup) return '';
        // Resolve the duplicate match's label via the shared helper (index-based lookups go stale once numbering is per-source).
        const resolved = resolveDuplicateMatchLabel(q, dup);
        if (!resolved) return '';
        const matchLabel = resolved.text +
          (resolved.matchQ.targetTerm ? ` (${escapeHtml(resolved.matchQ.targetTerm)})` : '');
        return `
      <div class="mb-3 px-3 py-2 rounded border border-danger/50 bg-danger/10 flex items-center justify-between gap-2">
        <p class="text-xs text-danger leading-snug">⚠ Possible duplicate of <strong>${matchLabel}</strong> — ${escapeHtml(dup.reason)}.</p>
        <div class="flex items-center gap-2 shrink-0">
          <button type="button" data-action="dismissDuplicate" title="Clear the duplicate flag on this question"
            class="text-[0.62rem] font-mono uppercase tracking-wide text-mute hover:text-ink transition-colors">Not a duplicate</button>
          <button type="button" data-action="jumpToDuplicate" data-jump-id="${dup.matchId}"
            class="text-[0.62rem] font-mono uppercase tracking-wide text-danger hover:text-ink transition-colors">View →</button>
        </div>
      </div>`;
      })()}

      <label class="field-label">Target term <span class="normal-case text-mute/70">(derived from the Answer snippet · editable)</span></label>
      <input type="text" data-field="targetTerm" value="${escapeAttr(q.targetTerm)}" placeholder="e.g. Confinement"
        class="input-base" />
      ${fieldSyncSlotTemplate(q, 'term')}

      ${variantTabsTemplate(q)}

      <label class="field-label">Question text <span class="normal-case text-mute/70">(${isDerivedQuestionVariant(q, variant)
        ? 'derived from the Question + Answer snippets · editable'
        : escapeHtml((VARIANT_GROUP_META[GROUP_OF_TYPE[variant.type]] || {}).label || variant.type.replace('_', ' ')) + ' variant'})</span></label>
      <textarea data-field="questionText" rows="2" placeholder="${escapeAttr(VARIANT_PLACEHOLDERS[variant.type] || '')}"
        class="input-base resize-none">${escapeHtml(variant.questionText)}</textarea>
      ${isDerivedQuestionVariant(q, variant) ? fieldSyncSlotTemplate(q, 'question') : ''}

      <div class="flex items-center justify-between mt-4 pt-3 border-t border-edge">
        <label class="field-label mb-0">Source page</label>
        <input type="number" min="1" data-field="sourcePage" value="${q.sourcePage}"
          class="w-20 text-center bg-void border border-edge rounded py-1.5 font-mono text-sm focus:outline-none focus:border-amber" />
      </div>

      ${snippetPanelTemplate(q, 'source', tierMeta)}
      ${snippetPanelTemplate(q, 'question', tierMeta)}
      ${snippetPanelTemplate(q, 'answer', tierMeta)}
      ${q.scanError ? `<p class="text-xs text-danger mt-1.5">⚠ ${escapeHtml(q.scanError)}</p>` : ''}

      <div class="mt-3 pt-3 border-t border-edge">
        ${AUTO_SYNC_ENABLED ? `
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-[0.62rem] font-mono uppercase tracking-wide ${q.snippetBusy ? 'text-amber' : 'text-mute'}">
            ${q.snippetBusy
              ? (q.snippetSyncPending
                  ? '🔄 Auto-syncing snippets… (another edit queued)'
                  : '🔄 Auto-syncing snippets…')
              : '✓ Snippets auto-sync after each edit'}
          </span>
        </div>` : `
        <p class="text-[0.62rem] font-mono uppercase tracking-wide text-mute">Highlights recheck after each edit · snippets change only by scanning or editing them</p>`}
        ${q.snippetError ? `<p class="text-xs text-danger mt-1.5">⚠ ${escapeHtml(q.snippetError)}</p>` : ''}
      </div>
    </div>

    <div class="question-card bg-card border border-edge rounded-lg p-4 lg:p-5" data-id="${q.id}">
      <div class="flex items-center justify-between mb-1">
        <label class="field-label mb-0">Choices <span class="normal-case text-mute/70">${variant.type === 'category' ? '(check every correct answer)' : '(select the correct one)'}</span></label>
        <button type="button" data-action="regenerateChoices" ${q.choicesBusy ? 'disabled' : ''}
          title="Ask the AI to regenerate this variant's choices + correct answer from the CURRENT question text (and answer/target term, if set) — use after editing the question or answer so the distractors and correct choice line up again"
          class="text-[0.62rem] font-mono uppercase tracking-wide text-mute hover:text-amber transition-colors shrink-0 ml-2 disabled:opacity-60 disabled:cursor-wait">
          ${q.choicesBusy ? '… generating' : '🪄 Auto-fill (AI)'}
        </button>
      </div>
      <div class="space-y-2">${choiceRowsTemplate(q, variant)}</div>
      ${variant.type !== 'true_false' ? `
      <button type="button" data-action="addChoice"
        class="mt-2 w-full font-mono text-[0.62rem] uppercase tracking-wide px-2 py-1.5 rounded border border-dashed border-edge text-mute hover:border-amber hover:text-amber transition-colors">
        + Add choice
      </button>` : ''}
      ${q.choicesError ? `<p class="text-xs text-danger mt-2">⚠ ${escapeHtml(q.choicesError)}</p>` : ''}
    </div>
  `;
}

function renderActiveQuestion() {
  const q = state.questions.find(x => x.id === state.activeCardId);
  if (!q) {
    activeEditorEl.innerHTML = '';
    emptyState.classList.toggle('hidden', state.questions.length > 0);
    return;
  }
  emptyState.classList.add('hidden');
  const index = state.questions.findIndex(x => x.id === q.id);
  activeEditorEl.innerHTML = activeEditorTemplate(q, index, state.questions.length);
}

// ---------- Active editor interaction ----------
activeEditorEl.addEventListener('input', (e) => {
  const card = e.target.closest('.question-card');
  if (!card) return;
  const q = state.questions.find(x => x.id === card.dataset.id);
  if (!q) return;
  const variant = q.variants[q.activeVariantIndex];

  // Inline snippet editor: keep the unsaved text on the question so a re-render doesn't lose it; nothing is committed until Save.
  if (e.target.dataset.snippetEdit) { q.editDraft = e.target.value; return; }

  const field = e.target.dataset.field;
  if (field === 'targetTerm') {
    q.targetTerm = e.target.value;
    patchFieldSyncRow(q, 'term'); // field sync: indicator appears/disappears while typing; only the row is patched, never the input
  } else if (field === 'questionText') {
    variant.questionText = e.target.value;
    if (isDerivedQuestionVariant(q, variant)) patchFieldSyncRow(q, 'question');
  } else if (field === 'choice') {
    const i = Number(e.target.dataset.choiceIndex);
    variant.choices[i] = e.target.value;
  } else if (field === 'sourcePage') {
    const val = Math.max(1, parseInt(e.target.value, 10) || 1);
    q.sourcePage = val;
    renderDocPage(val);
  }
});

activeEditorEl.addEventListener('change', (e) => {
  const card = e.target.closest('.question-card');
  if (!card) return;
  const q = state.questions.find(x => x.id === card.dataset.id);
  if (!q) return;

  if (e.target.dataset.action === 'setCorrect') {
    const variant = q.variants[q.activeVariantIndex];
    variant.correctAnswerIndex = Number(e.target.dataset.choiceIndex);
    renderActiveQuestion();
    onSnippetRelevantEdit(q.id); // the correct answer just changed — re-check/resync its snippets
  } else if (e.target.dataset.action === 'toggleCorrect') {
    const variant = q.variants[q.activeVariantIndex];
    const i = Number(e.target.dataset.choiceIndex);
    const set = new Set(variant.correctAnswerIndices || []);
    if (set.has(i)) set.delete(i); else set.add(i);
    variant.correctAnswerIndices = Array.from(set).sort((a, b) => a - b);
    renderActiveQuestion();
    onSnippetRelevantEdit(q.id); // the correct answers just changed — re-check/resync its snippets
  } else if (e.target.dataset.field === 'sourcePage') {
    // Committed edit — re-sort by page and re-index the nav chips + active editor title.
    sortQuestionsByPage();
    renderQuestionNav();
    renderActiveQuestion();
    onSnippetRelevantEdit(q.id); // the source page moved — its old snippets may no longer apply
  } else if (e.target.dataset.field === 'targetTerm') {
    // Committed edit — a manual rename can create/resolve a duplicate, so re-run the checker and refresh the badges.
    renderQuestionNav();
    renderActiveQuestion();
    onSnippetRelevantEdit(q.id);
  } else if (e.target.dataset.field === 'questionText') {
    // Committed edit — the snippets may now point at the wrong passage; auto re-check + resync.
    onSnippetRelevantEdit(q.id);
  } else if (e.target.dataset.field === 'choice') {
    onSnippetRelevantEdit(q.id);
  }
});

// Clears the duplicate flag for a given question id.
function dismissDuplicateForQuestion(qid) {
  const q = state.questions.find(x => x.id === qid);
  if (!q) return;
  // computeDuplicateMap() skips any question with dupeDismissed set, so it won't be re-flagged until edited enough to change what it matches against.
  q.dupeDismissed = true;
  renderQuestionNav();
  renderActiveQuestion();
}

// Field sync buttons must not steal focus: mousedown on a button blurs the input first, the `change` handler then re-renders the whole editor
// (renderActiveQuestion) and the button under the cursor is replaced before `click` fires, so the click is lost. Cancelling mousedown keeps the
// input focused (no blur / change), and the click below lands on the real button. Keyboard activation (Tab + Enter) is unaffected.
activeEditorEl.addEventListener('mousedown', (e) => {
  if (e.target.closest('[data-action="fieldSync"], [data-action="fieldSyncKeep"]')) e.preventDefault();
});

activeEditorEl.addEventListener('click', (e) => {
  // Field sync (Batch 4): "↻ Sync from snippet" / "Keep mine". Handled first; both are no-ops for a disabled / underivable pair.
  const fieldSyncBtn = e.target.closest('[data-action="fieldSync"]');
  if (fieldSyncBtn) {
    const card = e.target.closest('.question-card');
    const q = card && state.questions.find(x => x.id === card.dataset.id);
    if (!q || fieldSyncBtn.disabled) return;
    applyFieldSync(q, fieldSyncBtn.dataset.pair); // false (nothing written) when the pair can't be derived
    renderQuestionNav();    // the target term feeds nav chip titles, the duplicate map and the term panel
    renderActiveQuestion(); // shows the written value and drops the sync row
    return;
  }
  const fieldKeepBtn = e.target.closest('[data-action="fieldSyncKeep"]');
  if (fieldKeepBtn) {
    const card = e.target.closest('.question-card');
    const q = card && state.questions.find(x => x.id === card.dataset.id);
    if (!q) return;
    keepFieldAsIs(q, fieldKeepBtn.dataset.pair);
    patchFieldSyncRow(q, fieldKeepBtn.dataset.pair); // text unchanged, so only the row needs to go
    return;
  }
  const deleteBtn = e.target.closest('[data-action="delete"]');
  if (deleteBtn) {
    const card = e.target.closest('.question-card');
    if (card) deleteQuestion(card.dataset.id);
    return;
  }
  const duplicateBtn = e.target.closest('[data-action="duplicate"]');
  if (duplicateBtn) {
    const card = e.target.closest('.question-card');
    if (!card) return;
    const clone = duplicateQuestion(card.dataset.id);
    if (clone) {
      renderTextVersion();   // redraw Pane 2 so the clone's marks (shared with the original's) are in place
      setActiveCard(clone.id);
    }
    return;
  }
  const tabBtn = e.target.closest('[data-action="switchVariant"]');
  if (tabBtn) {
    const card = e.target.closest('.question-card');
    if (!card) return;
    const q = state.questions.find(x => x.id === card.dataset.id);
    if (!q) return;
    q.activeVariantIndex = Number(tabBtn.dataset.variantIndex);
    renderActiveQuestion();
    return;
  }
  const locateBtn = e.target.closest('[data-action="locateSnippet"]');
  if (locateBtn) {
    const card = e.target.closest('.question-card');
    if (!card) return;
    locateSnippetInDoc(card.dataset.id, locateBtn.dataset.snippetType);
    return;
  }
  const scanFieldBtn = e.target.closest('[data-action="scanField"]');
  if (scanFieldBtn) {
    const card = e.target.closest('.question-card');
    if (!card) return;
    handleScanField(card.dataset.id, scanFieldBtn.dataset.fieldType);
    return;
  }
  const scanOutsideBtn = e.target.closest('[data-action="scanAnswerOutside"]');
  if (scanOutsideBtn) {
    const card = e.target.closest('.question-card');
    if (card) handleScanAnswerOutside(card.dataset.id);
    return;
  }
  const editSnipBtn = e.target.closest('[data-action="editSnippet"]');
  if (editSnipBtn) {
    const card = e.target.closest('.question-card');
    if (card) startSnippetEdit(card.dataset.id, editSnipBtn.dataset.fieldType);
    return;
  }
  const saveSnipBtn = e.target.closest('[data-action="saveSnippetEdit"]');
  if (saveSnipBtn) {
    const card = e.target.closest('.question-card');
    if (card) saveSnippetEdit(card.dataset.id, saveSnipBtn.dataset.fieldType);
    return;
  }
  const cancelSnipBtn = e.target.closest('[data-action="cancelSnippetEdit"]');
  if (cancelSnipBtn) {
    const card = e.target.closest('.question-card');
    if (card) cancelSnippetEdit(card.dataset.id);
    return;
  }
  const jumpBtn = e.target.closest('[data-action="jumpToDuplicate"]');
  if (jumpBtn) {
    setActiveCard(jumpBtn.dataset.jumpId);
    return;
  }
  const dismissBtn = e.target.closest('[data-action="dismissDuplicate"]');
  if (dismissBtn) {
    const card = e.target.closest('.question-card');
    if (!card) return;
    dismissDuplicateForQuestion(card.dataset.id);
    return;
  }
  const genVariantBtn = e.target.closest('[data-action="generateVariant"]');
  if (genVariantBtn) {
    const card = e.target.closest('.question-card');
    if (!card) return;
    handleGenerateVariant(card.dataset.id, genVariantBtn.dataset.variantType);
    return;
  }
  const removeVariantBtn = e.target.closest('[data-action="removeVariant"]');
  if (removeVariantBtn) {
    const card = e.target.closest('.question-card');
    if (!card) return;
    removeVariant(card.dataset.id, Number(removeVariantBtn.dataset.variantIndex));
    return;
  }
  const regenChoicesBtn = e.target.closest('[data-action="regenerateChoices"]');
  if (regenChoicesBtn) {
    const card = e.target.closest('.question-card');
    if (!card) return;
    handleRegenerateChoices(card.dataset.id);
    return;
  }
  const addChoiceBtn = e.target.closest('[data-action="addChoice"]');
  if (addChoiceBtn) {
    const card = e.target.closest('.question-card');
    if (!card) return;
    const q = state.questions.find(x => x.id === card.dataset.id);
    if (!q) return;
    const variant = q.variants[q.activeVariantIndex];
    if (!variant || variant.type === 'true_false') return;
    variant.choices.push(''); // no upper limit — base is 4, grows from there
    renderActiveQuestion();
    requestAnimationFrame(() => {
      const rows = activeEditorEl.querySelectorAll(`[data-id="${q.id}"] [data-field="choice"]`);
      const last = rows[rows.length - 1];
      if (last) last.focus();
    });
    return;
  }
  const removeChoiceBtn = e.target.closest('[data-action="removeChoice"]');
  if (removeChoiceBtn) {
    const card = e.target.closest('.question-card');
    if (!card) return;
    const q = state.questions.find(x => x.id === card.dataset.id);
    if (!q) return;
    const variant = q.variants[q.activeVariantIndex];
    if (!variant || variant.type === 'true_false' || variant.choices.length <= MIN_CHOICES) return;
    const removedIndex = Number(removeChoiceBtn.dataset.choiceIndex);
    variant.choices.splice(removedIndex, 1);
    if (variant.type === 'category') {
      // Drop the removed index and shift every later index down by one, matching the choices array.
      variant.correctAnswerIndices = (variant.correctAnswerIndices || [])
        .filter(i => i !== removedIndex)
        .map(i => (i > removedIndex ? i - 1 : i));
    } else if (variant.correctAnswerIndex === removedIndex) {
      variant.correctAnswerIndex = 0; // the correct choice was removed — fall back to the first
    } else if (variant.correctAnswerIndex > removedIndex) {
      variant.correctAnswerIndex -= 1;
    }
    renderActiveQuestion();
    onSnippetRelevantEdit(q.id);
    return;
  }
});

// Scrolls Pane 2 to the <mark>(s) for this question's source/answer snippet and briefly pulses them; a snippet spanning a block boundary is wrapped as multiple marks, all of which get pulsed together.
function locateSnippetInDoc(qid, snippetType) {
  // `~=` (word-match) so this still finds a shared mark whose data-qid carries several ids.
  const marks = docTextContainer.querySelectorAll(
    `mark[data-qid~="${qid}"][data-snippet-type="${snippetType}"]`
  );
  if (!marks.length) return; // snippet didn't resolve to a highlight — nothing to jump to

  marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  marks.forEach(m => {
    m.classList.remove('locate-pulse');
    // Force reflow so re-adding the class restarts the animation even if this mark was just pulsed.
    void m.offsetWidth;
    m.classList.add('locate-pulse');
  });
  setTimeout(() => marks.forEach(m => m.classList.remove('locate-pulse')), 1800);
}

questionNavEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-nav-id]');
  if (btn) setActiveCard(btn.dataset.navId);
});

// Pager's Prev/Next/numbered buttons, plus Left/Right keyboard paging, scoped to questionNavGroup so it doesn't interfere with arrow keys while typing in the editor.
questionNavPager.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-page-goto]');
  if (!btn || btn.disabled) return;
  navChipPage = Number(btn.dataset.pageGoto);
  renderQuestionNav();
  focusActiveNavPagerButton();
});

questionNavGroup.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const totalPages = totalNavChipPages();
  if (totalPages <= 1) return;
  e.preventDefault();
  navChipPage = e.key === 'ArrowLeft'
    ? Math.max(0, navChipPage - 1)
    : Math.min(totalPages - 1, navChipPage + 1);
  renderQuestionNav();
  focusActiveNavPagerButton();
});

addQuestionBtn.addEventListener('click', addQuestion);
removeDuplicatesBtn.addEventListener('click', removeFlaggedDuplicates);

// ---------- Bidirectional sync: nav <-> Pane 2 highlight <-> Pane 3 page ----------
// Single choke point for "view this question"; viaUserClick=false marks a purely programmatic activation so it doesn't clear the aiUnchecked flag.
function setActiveCard(id, viaUserClick = true) {
  const q = state.questions.find(x => x.id === id);
  // Clear the "unchecked" flag before the renders below, so they immediately reflect the cleared state.
  if (viaUserClick && q && q.aiUnchecked) {
    q.aiUnchecked = false;
  }

  // If the active term filter doesn't match this question, clear it first so the paging below isn't computed against a list this question isn't in.
  if (activeTermFilterKey && q && normalizeTermKeyLoose(q.targetTerm || '') !== activeTermFilterKey) {
    activeTermFilterKey = null;
  }

  // Jump the nav-chip pager to the page containing the newly active question (computed against visibleQuestionEntries() to respect any active term filter).
  const entries = visibleQuestionEntries();
  const activeEntryIdx = entries.findIndex(({ q: eq }) => eq.id === id);
  if (activeEntryIdx !== -1) navChipPage = Math.floor(activeEntryIdx / NAV_CHIPS_PER_PAGE);

  state.activeCardId = id;
  renderQuestionNav();
  renderActiveQuestion();

  if (q) renderDocPage(q.sourcePage);

  // A mark's data-qid may hold multiple ids (shared duplicate-pair mark), so read the full list via markQidList(); a shared mark shows "unchecked" if any of its questions still needs review and isn't duplicate-suppressed.
  document.querySelectorAll('mark[data-qid]').forEach(m => {
    const ids = markQidList(m);
    m.classList.toggle('active-highlight', ids.includes(id));
    // Mirrors each mark's unchecked state in the same loop so Pane 2 stays in sync; suppressed when the question is duplicate-flagged.
    const showUnchecked = ids.some(mid => {
      const markQ = state.questions.find(x => x.id === mid);
      const markDup = markQ && getDuplicateMap().get(markQ.id);
      return !!(markQ && markQ.aiUnchecked && !markDup);
    });
    m.classList.toggle('unchecked-highlight', showUnchecked);
  });
  // Prefer the source mark, then question, then answer: an outside answer on an earlier page must not pull the view away from the question.
  const activeMark = ['source', 'question', 'answer']
    .map(t => docTextContainer.querySelector(`mark[data-qid~="${id}"][data-snippet-type="${t}"]`))
    .find(Boolean);
  if (activeMark) activeMark.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export {
  escapeHtml,
  escapeAttr,
  buildNavChipHtml,
  renderQuestionNav,
  renderPane3QuestionNav,
  renderTermBar, // also called by doc-pane-navigation.js's renderSourcePage()
  resetTermSearchOnSourceSwitch, // called by main.js's openSource()
  registerSourceSwitcher, // called once by main.js to wire openSource() into the term-panel handlers above
  variantIndexesOfGroup,
  variantTabsTemplate,
  choiceRowsTemplate,
  activeEditorTemplate,
  renderActiveQuestion,
  locateSnippetInDoc,
  setActiveCard,
};