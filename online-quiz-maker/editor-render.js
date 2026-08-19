// editor-render.js
// Extracted verbatim from online-quiz-maker.html, source lines 1083-1694
// (escapeHtml through setActiveCard, including the activeEditorEl event
// wiring block that sits between renderActiveQuestion and
// locateSnippetInDoc in the original file — moved with its handlers per
// the "move with handler" event-wiring strategy noted in the schema).
// Function/const bodies are UNCHANGED from source — only import/export
// wrapper lines were added, plus the same mechanical
// duplicateMap -> getDuplicateMap()/setDuplicateMap() substitution
// already flagged in question-model.js (ES imports are read-only, and
// this module also reassigns duplicateMap at its two renderQuestionNav
// call sites, same as removeFlaggedDuplicates did).

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

// UPDATE 3 (term nav bar — see UI_UPGRADES_HANDOFF_PROMPT.md): pulled in
// for buildTermGroups()'s "same term" grouping, using the exact same
// normalization computeDuplicateMap() already uses for its "same target
// term" duplicate check, so a person never sees a question grouped one
// way in the term bar and flagged a different way in the duplicate
// warning. NOTE (structural, not a logic change): text-normalize.js
// already imports escapeHtml from THIS file, so this creates a 2-file
// import cycle — same category and same safety reasoning as the
// existing highlighting.js <-> editor-render.js cycle noted above for
// markQidList: every use of normalizeTermKeyLoose below is inside a
// function body (buildTermGroups, setActiveCard), never at top-level
// module-evaluation time, so the cycle is safe.
import { normalizeTermKeyLoose } from './text-normalize.js';

// NOTE (structural, not a logic change): TIER_META and DATA_STATUS_META
// were originally declared inline near question-model.js's section of the
// source but are read here too (activeEditorTemplate). See the same NOTE
// in question-model.js — both modules import from the shared
// classification-meta.js instead of duplicating the objects.
import { TIER_META, DATA_STATUS_META } from './classification-meta.js';

// NOTE (structural, not a logic change): MIN_CHOICES was declared inline
// in this section of the source (line 1273) but is also read by
// variant-generation.js's isValidChoiceCount (source line 3099). Lifted
// verbatim into shared-constants.js so both modules reference the same
// value instead of duplicating it.
import { MIN_CHOICES } from './shared-constants.js';

// Functions from other modules that these functions/handlers call:
import { computeDuplicateMap, computeDataClassification, deleteQuestion,
         removeVariant, sortQuestionsByPage, addQuestion,
         removeFlaggedDuplicates } from './question-model.js';
import { renderDocPage } from './doc-pane-navigation.js';
import { scheduleAutoSync, handleScanField } from './snippet-question-generation.js';
import { handleGenerateVariant, handleRegenerateChoices } from './variant-generation.js';
// HIGHLIGHT_DUPLICATE_SHARED_MARK_FIX_PROMPT.md: a <mark>'s data-qid can
// now hold more than one id (see the multi-qid mark helpers block near the
// top of highlighting.js) — markQidList is the canonical way to read it.
// highlighting.js already imports renderQuestionNav/renderActiveQuestion
// from THIS file, so this creates a 2-file import cycle; safe because
// markQidList is only ever called from inside a function body (never at
// top-level module-evaluation time) in either file.
import { markQidList } from './highlighting.js';

// ---------------------------------------------------------------------
// Verbatim from source, lines 1083-1088
// ---------------------------------------------------------------------
function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

// =====================================================================
// PANE 1 — question nav chips + the single "active" editor
// =====================================================================

// New (not from source) — Update 1 (paginated nav-chip bar). With
// large question sets the full Pane 1 chip grid used to render every
// chip at once (an unbroken wall past ~50 questions). Caps the visible
// window at 20 chips and adds a Google-classic pager (numbered pages in
// blocks of 10 + Prev/Next) below the grid. See renderQuestionNav()
// and buildPagerHtml() below.
//
// `navChipPage` is a plain module-level `let`, not core-state.js
// getter/setter state: it's only ever read/reassigned from inside this
// module (renderQuestionNav, the pager's own click/keydown handlers,
// and setActiveCard — all declared in this file), so it doesn't need
// the cross-module getter/setter treatment core-state.js uses for
// things like duplicateMap. Same reasoning doc-pane-navigation.js gives
// for keeping renderTaskInFlight/pptxRenderGeneration as plain module
// `let`s.
const NAV_CHIPS_PER_PAGE = 20;
const NAV_PAGER_BLOCK_SIZE = 10; // how many numbered page buttons show before Next steps to the next block — same behavior as Google's classic results pager
let navChipPage = 0;

// UPDATE 3 (term nav bar — see UI_UPGRADES_HANDOFF_PROMPT.md): which
// term the chip grid is currently filtered to, as a
// normalizeTermKeyLoose() key, or null when unfiltered. Same
// module-level-`let` treatment as navChipPage just above and for the
// same reason — only ever read/reassigned from inside this module
// (renderQuestionNav, setActiveCard, and this term bar's own click
// handlers), so it doesn't need core-state.js's cross-module
// getter/setter treatment.
// DESIGN DECISION (flagged per the handoff doc's "don't silently
// assume" instruction): clicking a term FILTERS this existing chip
// grid (reusing Update 1's pager) rather than opening a separate
// modal/view, so there's one source of truth for "which questions are
// currently shown" instead of two parallel lists to keep in sync.
let activeTermFilterKey = null;

// UPDATE3_TERM_PANE_PROMPT.md item 2 (show-all vs. active-page-only
// scope toggle): which set of questions the term PANEL draws its
// visible rows from — 'all' (every term across the whole quiz, the
// pre-existing behavior) or 'page' (only terms belonging to a question
// on the page currently shown in Pane 3, for the active source). Same
// module-level-`let` treatment as activeTermFilterKey/navChipPage above
// and for the same reason — only ever read/reassigned from inside this
// module (this toggle's own click handler and renderTermBar). Note this
// is a DIFFERENT axis than activeTermFilterKey above: that one filters
// Pane 1's QUESTION chip grid down to one already-chosen term;
// termScopeMode instead decides which term ROWS show up in this panel
// in the first place. DESIGN DECISION (per the handoff prompt's "should
// toggle/search state reset when activeSourceId changes" question):
// does NOT reset on source switch — it's a standing display preference
// ("I always want to see just this page's terms"), not something tied
// to any one document. See termSearchQuery below for the opposite
// choice on search text, and resetTermSearchOnSourceSwitch() further
// down for where that's wired.
let termScopeMode = 'all'; // 'all' | 'page'

// UPDATE3_TERM_PANE_PROMPT.md item 3 (search bar): live text typed into
// #termSearchInput, matched case-insensitively as a substring against
// each term group's label. Same module-level-`let` treatment as
// termScopeMode above. DESIGN DECISION: combines with termScopeMode
// rather than overriding it — see filterTermGroupsForPanel() below —
// and, unlike termScopeMode, IS reset (to '') whenever
// state.activeSourceId changes, since a leftover query typed against a
// different document is more likely to confuse than help. See
// resetTermSearchOnSourceSwitch() further down.
let termSearchQuery = '';

// PER_SOURCE_QUESTION_SCOPING_AND_PERF_FIX_PROMPT.md (Issue 1): Pane 1's
// chip grid now shows only the ACTIVE source's own questions, plus any
// question with no sourceId at all (a manually-added question from
// before any document was ever imported) — same source-scoping
// precedent already established by renderPane3QuestionNav() and
// recheckHighlights() (highlighting.js). ANDed with the existing
// (optional) term filter below — both conditions apply together if a
// term filter happens to also be active.
//
// Every question that should currently be visible in the Pane 1 chip
// list, paired with its GLOBAL index in state.questions — every
// question in-scope when no term filter is active, or just the ones
// sharing the filtered term's normalized key otherwise. NOTE: the
// GLOBAL index `i` here is no longer what gets displayed as Q01/Q02/...
// — see perSourceDisplayIndex() below, which renderQuestionNav() and
// renderPane3QuestionNav() both call instead now that numbering must be
// sequential within a source rather than global (Issue 1b). `i` is kept
// on these entries because it's still a stable per-question array
// position other code may rely on incidentally; it's just not the
// display number anymore.
function visibleQuestionEntries() {
  return state.questions
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => q.sourceId === state.activeSourceId || q.sourceId == null)
    .filter(({ q }) => !activeTermFilterKey || normalizeTermKeyLoose(q.targetTerm || '') === activeTermFilterKey);
}

// Issue 1b/1c: every question belonging to `sourceId`, plus every
// question with no sourceId at all (mirrors visibleQuestionEntries()'s
// source filter above, generalized to any source — not just whichever
// one is currently active). Deliberately NOT further narrowed by
// activeTermFilterKey: numbering must stay stable regardless of whether
// a term filter happens to be on, same principle the old global-index
// numbering used to guarantee before multi-source support existed (see
// the comment above visibleQuestionEntries()) — a chip's number should
// never shift around just because someone clicked a term filter.
function sourceScopedEntries(sourceId) {
  return state.questions
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => q.sourceId === sourceId || q.sourceId == null);
}

// The canonical "per-source display number" (0-based) for a given
// question — what buildNavChipHtml turns into its Q01/Q02/... label.
// Computed from q's OWN sourceId (not state.activeSourceId), so this
// also gives the right answer for a question belonging to a source that
// ISN'T currently active — needed by the cross-file duplicate-warning
// label (Issue 1c) below. For the common case, where q's source IS the
// active one, this resolves against exactly the same bucket Pane 1 and
// Pane 3 are both rendering from, so the two can never disagree about
// what number the same question shows.
function perSourceDisplayIndex(q) {
  return sourceScopedEntries(q.sourceId).findIndex(({ q: eq }) => eq.id === q.id);
}

function totalNavChipPages() {
  return Math.max(1, Math.ceil(visibleQuestionEntries().length / NAV_CHIPS_PER_PAGE));
}

// Builds the numbered-page + Prev/Next controls for whatever
// `navChipPage` currently is. Returns '' when everything fits on one
// page, so the caller can hide the pager entirely instead of showing a
// single, useless "1" button.
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

// Re-focuses whichever pager button represents the current page, right
// after a pager-triggered re-render destroys and rebuilds the pager's
// DOM (innerHTML replacement drops focus otherwise). Keeps repeated
// arrow-key presses working without the person needing to re-click
// into the panel between each one.
function focusActiveNavPagerButton() {
  const btn = questionNavPager.querySelector('.nav-pager-btn-active');
  if (btn) btn.focus();
}

// Shared chip markup for both Pane 1's full nav and Pane 3's
// current-page-scoped nav below — keeps the two visually identical.
// ---------------------------------------------------------------------
// Verbatim from source, lines 1095-1107, plus the `nav-chip-unchecked`
// class added below by UNCHECKED_AI_CONTENT_AND_FUZZY_HIGHLIGHT_
// PERSISTENCE_PROMPT.md Part B, following the exact same pattern as the
// existing `nav-chip-duplicate` class (see styles.css for both rules).
// SUPPRESS_UNCHECKED_INDICATOR_FOR_DUPLICATES_PROMPT.md: `&& !dup`
// added to that condition — a question already flagged as a possible
// duplicate needs the person's attention for that reason, so the
// separate "unchecked" signal is suppressed rather than stacked on top
// of it. `dup` is already this function's own parameter, so no new
// lookup is needed here.
// ---------------------------------------------------------------------
// Issue 1c: dup.matchIndex used to be computeDuplicateMap()'s stored
// GLOBAL index of the matched question — that no longer corresponds to
// anything shown on screen now that numbering is per-source, so it's
// resolved at render time instead via dup.matchId + perSourceDisplayIndex()
// (matchIndex itself is left unused going forward; still present on the
// map entry, just not read anymore — see question-model.js). A
// same-source match keeps a bare "Q0N" label; a cross-file match (a
// real, expected case — "same target term" duplicate detection has no
// source restriction) also names the other file, since a bare "Q0N"
// would refer to a different question in the CURRENTLY-visible file's
// own numbering otherwise.
//
// Shared by buildNavChipHtml's tooltip below AND activeEditorTemplate's
// duplicate-warning box further down this file — that box read
// dup.matchIndex directly too (the identical stale-numbering bug, just
// a second render site), found while making this exact fix here. One
// shared resolver keeps the two label strings from ever disagreeing,
// same reasoning already applied to Pane 1/Pane 3's shared
// perSourceDisplayIndex() above. Returns null if the matched question no
// longer exists (deleted since the map was last computed).
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
    // resolved === null: matched question was deleted since the map was
    // last computed — fall back to baseTitle rather than show a stale label.
  }
  return `
    <button type="button" data-nav-id="${q.id}" data-tier="${q.tier || 1}"
      class="nav-chip ${q.id === state.activeCardId ? 'nav-chip-active' : ''} ${q.sourceSnippet ? 'nav-chip-snippet' : ''} ${dup ? 'nav-chip-duplicate' : ''} ${(q.aiUnchecked && !dup) ? 'nav-chip-unchecked' : ''}"
      title="${escapeAttr(title)}">
      Q${String(displayIndex + 1).padStart(2, '0')}
    </button>
  `;
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 1109-1118, except the single mechanical
// `duplicateMap = computeDuplicateMap();` -> `setDuplicateMap(...)`
// substitution (see NOTE at top of file).
// ---------------------------------------------------------------------
function renderQuestionNav() {
  setDuplicateMap(computeDuplicateMap());

  // UPDATE 3: if the active term filter no longer matches any question
  // (its last question was deleted, retargeted, or had its target term
  // cleared), auto-clear it here — before this render's visible entries
  // are computed below — so the chip grid falls back to "show
  // everything" instead of getting stuck showing "no questions match"
  // for a term that no longer exists anywhere in the quiz.
  if (activeTermFilterKey && !state.questions.some(q => normalizeTermKeyLoose(q.targetTerm || '') === activeTermFilterKey)) {
    activeTermFilterKey = null;
  }

  // New (not from source) — Update 1: clamp navChipPage in case the
  // question count shrank (e.g. removeFlaggedDuplicates/deleteQuestion)
  // since the last render and the previously-shown page no longer
  // exists.
  navChipPage = Math.min(Math.max(0, navChipPage), totalNavChipPages() - 1);

  if (state.questions.length === 0) {
    questionNavEl.innerHTML = '';
    questionNavPager.innerHTML = '';
    questionNavPager.classList.add('hidden');
  } else {
    // UPDATE 3: pageItems now comes from visibleQuestionEntries()
    // (source-scoped per Issue 1, further narrowed by any active term
    // filter) rather than slicing state.questions directly. Issue 1b:
    // displayIndex is now perSourceDisplayIndex(q) — the question's
    // position within its OWN source's numbering — rather than the
    // entry's global array index `i`, so a second file's questions
    // still start at Q01 instead of continuing the first file's count.
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
  renderTermBar(); // UPDATE 3 — keep the term panel (and any duplicate rows inside it) in sync with every nav-affecting change, same call site as renderPane3QuestionNav above and for the same reason
}

// Pane 3's own mini nav: every question whose sourcePage matches
// whatever page is currently on screen there, using the same Q01/Q02
// numbering (each chip's displayIndex) as Pane 1 so the two stay
// consistent. Hidden entirely when the current source page has no
// questions on it. Called from renderQuestionNav (so it tracks any
// question-list change) and from renderSourcePage (so it tracks page
// navigation, which doesn't otherwise touch the question list).
// ---------------------------------------------------------------------
// Verbatim from source, lines 1128-1140, except the same mechanical
// duplicateMap -> getDuplicateMap() substitution, PLUS an additive
// q.sourceId check — see UPDATE 2B note below.
// ---------------------------------------------------------------------
// UPDATE 2B (bug found during verification for Update 2B item 3 — see
// UI_UPGRADES_HANDOFF_PROMPT.md; not one of the doc's 5 listed items,
// but discovered while checking this file's page-lookup logic for
// multi-source correctness, so fixed here and flagged explicitly
// rather than left in): with only one possible source, "sourcePage
// matches state.currentPage" and "this question belongs to the source
// Pane 3 is showing" were the same condition. With multiple sources
// they're not — page 3 of source A and page 3 of source B are
// different pages that happen to share a number, and Pane 3 only ever
// shows ONE source's page N at a time (state.currentPage is a plain
// page number, not itself source-scoped). Without the sourceId check,
// a question from a completely different, non-active source could
// wrongly appear in Pane 3's mini-nav (and its chip would then open
// via setActiveCard onto content that doesn't match it). Restricting
// to q.sourceId === state.activeSourceId fixes this.
function renderPane3QuestionNav() {
  const chips = [];
  state.questions.forEach((q) => {
    if (q.sourceId !== state.activeSourceId || q.sourcePage !== state.currentPage) return;
    // Issue 1b: call through the same perSourceDisplayIndex() helper
    // renderQuestionNav() uses for Pane 1's chips, rather than computing
    // a separate numbering scheme here — this is what guarantees the two
    // panes can never show different numbers for the same question.
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
// PANE 1 — term nav bar (Update 3, new — see UI_UPGRADES_HANDOFF_PROMPT.md)
// =====================================================================
// Important: the duplicate-detection engine this panel surfaces already
// exists and is fully wired (computeDuplicateMap, normalizeTermKeyLoose,
// q.dupeDismissed) — everything below is new browsing/filtering UI on
// top of it, not new detection logic.

// Groups every question with a non-blank targetTerm by
// normalizeTermKeyLoose() — the exact same "same term" notion
// computeDuplicateMap() already uses for its own "same target term"
// duplicate check (see question-model.js) — so two spellings or
// pluralizations of one concept collapse into a single row here just
// like they'd collapse into a single duplicate flag there. This is the
// "collapse, don't list separately" option from the handoff doc's
// design-decision note. `label` is just the first-seen raw targetTerm
// for that key, for display only — grouping and filtering both go
// through the normalized key, never the label.
//
// DESIGN NOTE: this recomputes the grouping fresh from state.questions
// rather than extending ai-prompt-builders.js's collectTargetTerms().
// That function already exists and returns a flat, deduped array of
// term strings, but it's on the hot path of AI bulk-generation (each
// tier pass's exclusion-list prompt) and doesn't carry per-term
// question-id lists, which this panel needs. Changing its return shape
// risked touching AI-prompt-building code for a rendering feature;
// deriving the grouping fresh here instead is cheap (this only ever
// runs on a nav re-render, over an in-memory array) and keeps this
// update scoped to Pane 1.
// UPDATE3_TERM_PANE_PROMPT.md item 2: does `q` qualify for the
// "This page" scope? Multi-source aware — mirrors the exact check
// renderPane3QuestionNav() already uses (see above): sourceId AND
// sourcePage both have to match, since two different imported
// documents can reuse the same page numbers.
function questionOnActivePage(q) {
  return q.sourceId === state.activeSourceId && q.sourcePage === state.currentPage;
}

// UPDATE3_TERM_PANE_PROMPT.md items 2+3: narrows buildTermGroups()'s
// full group list down to what the term PANEL should actually render,
// applying the show-all/active-page scope and the search query
// TOGETHER (per the handoff prompt's design decision: search filters
// within the current scope rather than overriding it — the more
// expected behavior for combined filters). Doesn't touch
// buildTermGroups() itself or its groups' `questionIds` — a surviving
// row's "N questions" count still reflects that term's TOTAL usage
// across the whole quiz, same as before this update; scope/search only
// decide which term ROWS appear here, not what number each one reports
// (consistent with computeDuplicateMap()'s own quiz-wide notion of
// duplicates, which this panel's inline dupe warnings still draw on).
function filterTermGroupsForPanel(groups) {
  let visible = groups;
  if (termScopeMode === 'page') {
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

// One term row: the clickable filter button, plus — DESIGN DECISION
// (flagged per the handoff doc) — an inline duplicate-warning row for
// each of this term's questions that's currently flagged, with its own
// "View →" / "Not a duplicate" actions. This is IN ADDITION TO, not
// instead of, the existing warning box in the single-question editor
// (activeEditorTemplate above) — that box is untouched and still shows
// exactly as before. The inline copy here is a convenience for
// triaging several flagged questions under one term without leaving
// this panel; "View →" (viewFlaggedQuestion) opens the flagged
// question itself in the editor, where the full warning box (with its
// own View-the-original-match / dismiss actions) is still available.
function buildTermRowHtml(group) {
  const isActive = group.key === activeTermFilterKey;
  const dupQids = group.questionIds.filter((qid) => getDuplicateMap().has(qid));
  return `
    <div class="term-row ${isActive ? 'term-row-active' : ''}">
      <button type="button" data-action="filterByTerm" data-term-key="${escapeAttr(group.key)}"
        class="term-row-btn" title="Show only questions using this term">
        <span class="term-row-label">${escapeHtml(group.label)}</span>
        <span class="term-row-count">${group.questionIds.length} ${group.questionIds.length === 1 ? 'question' : 'questions'}</span>
      </button>
      ${dupQids.map((qid) => {
        const dup = getDuplicateMap().get(qid);
        const idx = state.questions.findIndex((x) => x.id === qid);
        return `
        <div class="term-row-dupe">
          <span class="term-row-dupe-text">⚠ Q${String(idx + 1).padStart(2, '0')} possible duplicate — ${escapeHtml(dup.reason)}</span>
          <button type="button" data-action="viewFlaggedQuestion" data-qid="${qid}" class="term-row-dupe-btn">View →</button>
          <button type="button" data-action="dismissDuplicateInline" data-qid="${qid}" class="term-row-dupe-btn">Not a duplicate</button>
        </div>`;
      }).join('')}
    </div>
  `;
}

// Renders the term list plus the "showing filtered term" indicator
// strip above the chip grid. Called from renderQuestionNav() (see
// above) so it stays in sync with every question-list change exactly
// the way renderPane3QuestionNav() already does — new questions, edited
// target terms, deletions, and dismissed duplicates all flow through
// renderQuestionNav() already, so no separate call sites are needed
// here.
//
// DESIGN NOTE: Pane 3's mini-nav (renderPane3QuestionNav, above) is
// deliberately NOT filtered by activeTermFilterKey — it's scoped to "the
// questions on the currently visible document page", a different
// browsing axis than "questions using this term", and filtering it too
// could hide a question from Pane 3 that's still on-screen in Pane 2.
function renderTermBar() {
  const groups = buildTermGroups();

  // UPDATE3_TERM_PANE_PROMPT.md item 2: reflect which scope button is
  // active. Read directly off termScopeMode (the single source of
  // truth) rather than any state baked into the button markup itself —
  // same pattern .term-row-active already uses for activeTermFilterKey.
  if (termScopeToggleEl) {
    termScopeToggleEl.querySelectorAll('[data-term-scope]').forEach((btn) => {
      btn.classList.toggle('term-scope-btn-active', btn.dataset.termScope === termScopeMode);
    });
  }

  // UPDATE3_TERM_PANE_PROMPT.md items 2+3: render from the
  // scope+search-filtered list, not the full one. Distinguishes "no
  // terms exist at all yet" (groups.length === 0) from "terms exist but
  // none match the current scope/search" (groups.length > 0 but
  // visibleGroups.length === 0) so the empty message actually explains
  // what's going on instead of always suggesting the quiz has no terms.
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

// Delegated click handling for the term panel: filtering the chip grid
// below, jumping straight to a flagged duplicate, or dismissing its
// warning — all without leaving this panel.
termBarEl.addEventListener('click', (e) => {
  const filterBtn = e.target.closest('[data-action="filterByTerm"]');
  if (filterBtn) {
    const key = filterBtn.dataset.termKey;
    // Clicking the already-active term again clears the filter, same
    // toggle behavior as a lot of filter-chip UIs elsewhere.
    activeTermFilterKey = (activeTermFilterKey === key) ? null : key;
    navChipPage = 0;
    renderQuestionNav();
    return;
  }
  const viewBtn = e.target.closest('[data-action="viewFlaggedQuestion"]');
  if (viewBtn) {
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

// UPDATE3_TERM_PANE_PROMPT.md item 2: scope-toggle clicks. Delegated on
// the wrapper (same pattern as termBarEl's listener above) rather than
// one listener per button. Re-renders just the term panel — this scope
// only affects WHICH TERM ROWS show here, not Pane 1's question chip
// grid, so renderQuestionNav()'s fuller re-render isn't needed.
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

// UPDATE3_TERM_PANE_PROMPT.md item 3: live search-as-you-type. Same
// "only this panel needs to re-render" reasoning as the scope toggle
// above.
if (termSearchInputEl) {
  termSearchInputEl.addEventListener('input', () => {
    termSearchQuery = termSearchInputEl.value;
    renderTermBar();
  });
}

// UPDATE3_TERM_PANE_PROMPT.md (design decision — see termSearchQuery's
// own comment above): clears the search box, but deliberately leaves
// termScopeMode untouched, whenever the active imported source changes.
// NOT WIRED UP YET: main.js's openSource() is the natural call site
// (right alongside its existing state.activeSourceId assignment), but
// main.js wasn't included in this pass's file set (see this prompt's
// "Files to send to the next agent" list), so this is exported ready to
// be called from there — add a one-line
// `resetTermSearchOnSourceSwitch();` call in openSource() to finish
// wiring it in.
function resetTermSearchOnSourceSwitch() {
  termSearchQuery = '';
  if (termSearchInputEl) termSearchInputEl.value = '';
  renderTermBar();
}

// Tab group order is fixed: Multiple Choice, then True/False, then
// Category Selection. Each is a GROUP that can hold zero or more
// variants (see the question-model note above), so the tab bar is
// built dynamically per-question from however many of each type it
// currently has. The "Multiple Choice" group merges two underlying
// variant types — the 'clamp' base (present by default on a new
// question, but removable like any other variant — see removeVariant)
// plus any 'rephrased' variations generated into it — so there's a
// single tab and a single "+ New variation" control for both, instead
// of two separate tabs like before.
// ---------------------------------------------------------------------
// Verbatim from source, lines 1157-1169
// ---------------------------------------------------------------------
const VARIANT_GROUP_META = {
  clamp: { label: 'Multiple Choice' },
  true_false: { label: 'True / False' },
  category: { label: 'Category Selection' },
};
// Maps a variant's own `type` to the tab group it displays under.
const GROUP_OF_TYPE = { clamp: 'clamp', rephrased: 'clamp', true_false: 'true_false', category: 'category' };
// The variant `type` that a group's "Generate" / "+ New variation"
// control should produce. For the merged Multiple Choice group this is
// 'rephrased' (the clamp base itself is never (re)generated this way);
// for the other groups it's just the group's own type.
const GROUP_GENERATE_TYPE = { clamp: 'rephrased', true_false: 'true_false', category: 'category' };
const GROUP_ORDER = ['clamp', 'true_false', 'category'];

// Every index in state.questions[].variants whose type belongs to the
// given tab group, in array order (creation order).
// ---------------------------------------------------------------------
// Verbatim from source, lines 1174-1177
// ---------------------------------------------------------------------
function variantIndexesOfGroup(q, group) {
  const out = [];
  q.variants.forEach((v, i) => { if (GROUP_OF_TYPE[v.type] === group) out.push(i); });
  return out;
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 1179-1260
// ---------------------------------------------------------------------
function variantTabsTemplate(q) {
  const activeVariant = q.variants[q.activeVariantIndex];
  const activeGroup = activeVariant ? (GROUP_OF_TYPE[activeVariant.type] || 'clamp') : 'clamp';

  const mainTab = (group) => {
    const idxs = variantIndexesOfGroup(q, group);
    const label = VARIANT_GROUP_META[group].label;
    const genType = GROUP_GENERATE_TYPE[group];

    // Not generated yet — locked, click-to-generate instead of a tab.
    // (Can happen for 'clamp' too now that its base variant is
    // removable — see removeVariant/subRow below.)
    if (idxs.length === 0) {
      const generating = q.generatingType === genType;
      return `
        <button type="button" data-action="generateVariant" data-variant-type="${genType}" ${generating ? 'disabled' : ''}
          title="Generate a ${label} variant with AI"
          class="flex-1 font-mono text-[0.62rem] tracking-wide uppercase px-2 py-1.5 rounded border border-dashed border-edge text-mute hover:border-amber hover:text-amber transition-colors disabled:opacity-60 disabled:cursor-wait disabled:hover:border-edge disabled:hover:text-mute">
          ${generating ? 'Generating…' : `🔒 ${label}`}
        </button>`;
    }

    // Already has 1+ variants — a normal tab. Jumps to whichever of
    // this group's variants is already active, or its first one.
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

  // Below the main tab row: for whichever group is ACTIVE, show one
  // small chip per variation (switch + individually remove) plus a "+"
  // chip to generate yet another variation of that group's type. This
  // is where "as many variations as they want" actually lives in the
  // UI, for every group including the merged Multiple Choice one. Any
  // single variation — including the clamp (Multiple Choice) base —
  // can be removed, as long as it isn't the question's last remaining
  // variant overall (removeVariant enforces that floor).
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

// Category Selection is checkbox-style (0+ correct answers, tracked in
// variant.correctAnswerIndices) — every other type is radio-style
// (exactly 1 correct answer, tracked in variant.correctAnswerIndex).
// Choice count has no hard cap for any type except true_false (always
// exactly True/False, so it gets no add/remove controls) — every other
// type starts at 4 by default (see newVariant) but can be grown or
// shrunk down to a minimum of MIN_CHOICES via the row's ✕ / the "+ Add
// choice" button below the list.
// ---------------------------------------------------------------------
// Verbatim from source, lines 1274-1306
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Verbatim from source, lines 1308-1315
// ---------------------------------------------------------------------
const VARIANT_PLACEHOLDERS = {
  clamp: 'Sentence-continuation prompt with the term blanked out (e.g. "___ is an electronic machine, operating under the control of instructions...")',
  // Kept for questions loaded from older exported JSON that still use
  // the retired multiple-choice "definition" variant type.
  definition: 'Definition-first prompt (e.g. "The restriction of an inmate to a segregated area is called what?")',
  rephrased: 'A differently-worded conceptual or scenario question testing the same term',
  true_false: 'A true/false statement derived from the source material',
  category: 'A "select all that apply" prompt (e.g. "What are the Components of a Computer?")',
};

// ---------------------------------------------------------------------
// Verbatim from source, lines 1318-1443, except the single mechanical
// `duplicateMap.get(q.id)` -> `getDuplicateMap().get(q.id)` substitution,
// and — per SUPPRESS_UNCHECKED_INDICATOR_FOR_DUPLICATES_PROMPT.md — the
// `dup` lookup itself moved up to the top of the function (it used to
// live only inside the duplicate-warning-box IIFE further down) so the
// "Unchecked" badge above can also read it, without computing
// getDuplicateMap().get(q.id) twice.
// ---------------------------------------------------------------------
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
            title="Data classification: Unclassified = source or answer snippet missing · Unverified = present but couldn't be highlighted · Verified = present and highlighted">
            ${dataStatusMeta.label}
          </span>
          ${q.definitionType === 'extension' ? `
          <span class="text-[0.6rem] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border border-edge text-mute">Extension</span>
          ` : ''}
          ${(q.aiUnchecked && !dup) ? `
          <!-- UNCHECKED_AI_CONTENT_AND_FUZZY_HIGHLIGHT_PERSISTENCE_PROMPT.md
               Part B — same badge treatment as the Extension badge just
               above, styled green (this app's convention for the
               "unchecked AI content" signal — see nav-chip-unchecked
               and mark.unchecked-highlight in styles.css). Cleared by
               setActiveCard() the moment this question is viewed.
               SUPPRESS_UNCHECKED_INDICATOR_FOR_DUPLICATES_PROMPT.md:
               `&& !dup` added — a possible-duplicate question already
               has the red warning box below asking for attention, so
               this badge is suppressed rather than stacked on top of
               it. -->
          <span class="text-[0.6rem] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border"
            style="background-color: #22c55e22; color: #22c55e; border-color: #22c55e55;"
            title="AI-autogenerated — not yet reviewed">Unchecked</span>
          ` : ''}
        </div>
        <button data-action="delete" title="Delete question collection"
          class="w-7 h-7 flex items-center justify-center rounded text-mute hover:text-danger hover:bg-danger/10 transition-colors">✕</button>
      </div>

      ${(() => {
        if (!dup) return '';
        // Issue 1c (and the identical bug found alongside it — see
        // resolveDuplicateMatchLabel's own comment above): dup.matchIndex
        // is a stale global index once numbering is per-source; resolve
        // via the same shared helper buildNavChipHtml uses instead.
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

      <label class="field-label">Target term <span class="normal-case text-mute/70">(the concept being defined)</span></label>
      <input type="text" data-field="targetTerm" value="${escapeAttr(q.targetTerm)}" placeholder="e.g. Confinement"
        class="input-base" />

      ${variantTabsTemplate(q)}

      <label class="field-label">Question text <span class="normal-case text-mute/70">(${escapeHtml((VARIANT_GROUP_META[GROUP_OF_TYPE[variant.type]] || {}).label || variant.type.replace('_', ' '))} variant)</span></label>
      <textarea data-field="questionText" rows="2" placeholder="${escapeAttr(VARIANT_PLACEHOLDERS[variant.type] || '')}"
        class="input-base resize-none">${escapeHtml(variant.questionText)}</textarea>

      <div class="flex items-center justify-between mt-4 pt-3 border-t border-edge">
        <label class="field-label mb-0">Source page</label>
        <input type="number" min="1" data-field="sourcePage" value="${q.sourcePage}"
          class="w-20 text-center bg-void border border-edge rounded py-1.5 font-mono text-sm focus:outline-none focus:border-amber" />
      </div>

      <div class="mt-3 pt-3 border-t border-edge">
        <div class="flex items-center justify-between mb-1">
          <label class="field-label mb-0">Source snippet <span class="normal-case text-mute/70">(${tierMeta.label} highlight in Pane 2)</span></label>
          <div class="flex items-center gap-2 shrink-0 ml-2">
            ${q.sourceSnippet ? `<button type="button" data-action="locateSnippet" data-snippet-type="question"
              class="text-[0.62rem] font-mono uppercase tracking-wide text-mute hover:text-violet transition-colors">Locate 🔍</button>` : ''}
            <button type="button" data-action="scanField" data-field-type="question"
              title="Highlight the question/context passage in the document text (Pane 2), then click here — whatever you've selected becomes this snippet"
              class="text-[0.62rem] font-mono uppercase tracking-wide text-mute hover:text-amber transition-colors">
              🔎 Scan question
            </button>
          </div>
        </div>
        ${q.sourceSnippet
          ? `<p class="text-xs text-mute italic leading-relaxed">"${escapeHtml(q.sourceSnippet)}"</p>`
          : `<p class="text-xs text-mute/60 italic">Not yet located — highlight the passage in the document text, then click "Scan question".</p>`}
      </div>
      <div class="mt-3 pt-3 border-t border-edge">
        <div class="flex items-center justify-between mb-1">
          <label class="field-label mb-0">Answer snippet <span class="normal-case text-mute/70">(green in Pane 2)</span></label>
          <div class="flex items-center gap-2 shrink-0 ml-2">
            ${q.answerSnippet ? `<button type="button" data-action="locateSnippet" data-snippet-type="answer"
              class="text-[0.62rem] font-mono uppercase tracking-wide text-mute hover:text-violet transition-colors">Locate 🔍</button>` : ''}
            <button type="button" data-action="scanField" data-field-type="answer"
              title="Highlight the exact answer/target-term passage in the document text (Pane 2), then click here — whatever you've selected becomes this snippet"
              class="text-[0.62rem] font-mono uppercase tracking-wide text-mute hover:text-amber transition-colors">
              🔎 Scan answer
            </button>
          </div>
        </div>
        ${q.answerSnippet
          ? `<p class="text-xs text-emerald-400/90 italic leading-relaxed">"${escapeHtml(q.answerSnippet)}"</p>`
          : `<p class="text-xs text-mute/60 italic">Not yet located — highlight the passage in the document text, then click "Scan answer".</p>`}
        ${q.scanError ? `<p class="text-xs text-danger mt-1.5">⚠ ${escapeHtml(q.scanError)}</p>` : ''}
      </div>

      <div class="mt-3 pt-3 border-t border-edge">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-[0.62rem] font-mono uppercase tracking-wide ${q.snippetBusy ? 'text-amber' : 'text-mute'}">
            ${q.snippetBusy
              ? (q.snippetSyncPending
                  // AUTOSYNC_REENTRANCY_RACE_FIX_PROMPT.md: a later edit
                  // landed while this resync was still in flight and is
                  // queued as a single trailing follow-up pass (see
                  // runAutoSync in snippet-question-generation.js) —
                  // say so, rather than looking identical to a normal
                  // single in-flight sync with no indication anything
                  // is still pending after it.
                  ? '🔄 Auto-syncing snippets… (another edit queued)'
                  : '🔄 Auto-syncing snippets…')
              : '✓ Snippets auto-sync after each edit'}
          </span>
        </div>
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

// ---------------------------------------------------------------------
// Verbatim from source, lines 1444-1454
// ---------------------------------------------------------------------
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
// ---------------------------------------------------------------------
// Verbatim from source, lines 1457-1522 (the 'input' and 'change'
// listeners on activeEditorEl)
// ---------------------------------------------------------------------
activeEditorEl.addEventListener('input', (e) => {
  const card = e.target.closest('.question-card');
  if (!card) return;
  const q = state.questions.find(x => x.id === card.dataset.id);
  if (!q) return;
  const variant = q.variants[q.activeVariantIndex];

  const field = e.target.dataset.field;
  if (field === 'targetTerm') {
    q.targetTerm = e.target.value;
  } else if (field === 'questionText') {
    variant.questionText = e.target.value;
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
    scheduleAutoSync(q.id); // the correct answer just changed — re-check/resync its snippets
  } else if (e.target.dataset.action === 'toggleCorrect') {
    const variant = q.variants[q.activeVariantIndex];
    const i = Number(e.target.dataset.choiceIndex);
    const set = new Set(variant.correctAnswerIndices || []);
    if (set.has(i)) set.delete(i); else set.add(i);
    variant.correctAnswerIndices = Array.from(set).sort((a, b) => a - b);
    renderActiveQuestion();
    scheduleAutoSync(q.id); // the correct answers just changed — re-check/resync its snippets
  } else if (e.target.dataset.field === 'sourcePage') {
    // Committed edit (blur / Enter) — re-sort by page and re-index the
    // nav chips + active editor title to reflect the new position.
    sortQuestionsByPage();
    renderQuestionNav();
    renderActiveQuestion();
    scheduleAutoSync(q.id); // the source page moved — its old snippets may no longer apply
  } else if (e.target.dataset.field === 'targetTerm') {
    // Committed edit (blur / Enter) — a manual rename can just as
    // easily create or resolve a duplicate as an AI-generated one, so
    // re-run the checker and refresh the nav badges + banner.
    renderQuestionNav();
    renderActiveQuestion();
    scheduleAutoSync(q.id);
  } else if (e.target.dataset.field === 'questionText') {
    // Committed edit (blur / Enter) — the question/answer just
    // changed, so its highlighted snippets may now point at the wrong
    // passage (or none at all yet). Auto re-check + resync rather than
    // requiring a manual button click.
    scheduleAutoSync(q.id);
  } else if (e.target.dataset.field === 'choice') {
    scheduleAutoSync(q.id);
  }
});

// UPDATE 3 (small refactor, not a logic change): pulled out of what was
// previously inline body of activeEditorEl's own "dismissDuplicate"
// click handler below, unchanged, so the term bar's new inline
// "Not a duplicate" action (see renderTermBar()'s click listener above)
// can call the exact same logic on an arbitrary qid instead of only the
// currently-active card. Behavior for the existing editor button is
// identical to before this change.
function dismissDuplicateForQuestion(qid) {
  const q = state.questions.find(x => x.id === qid);
  if (!q) return;
  // Manually clears the flag for THIS question only — computeDuplicateMap()
  // skips any question with dupeDismissed set, so it won't be re-flagged
  // (or swept up by "Remove Duplicates") until the person edits it enough
  // to change what it matches against.
  q.dupeDismissed = true;
  renderQuestionNav();
  renderActiveQuestion();
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 1523-1645 (the 'click' listener on
// activeEditorEl), EXCEPT the dismissDuplicate block now calls the
// dismissDuplicateForQuestion() helper just above instead of inlining
// the same three lines — see its own comment for why.
// ---------------------------------------------------------------------
activeEditorEl.addEventListener('click', (e) => {
  const deleteBtn = e.target.closest('[data-action="delete"]');
  if (deleteBtn) {
    const card = e.target.closest('.question-card');
    if (card) deleteQuestion(card.dataset.id);
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
      // Drop the removed index and shift every index after it down by
      // one, same as the choices array itself just did.
      variant.correctAnswerIndices = (variant.correctAnswerIndices || [])
        .filter(i => i !== removedIndex)
        .map(i => (i > removedIndex ? i - 1 : i));
    } else if (variant.correctAnswerIndex === removedIndex) {
      variant.correctAnswerIndex = 0; // the correct choice was removed — fall back to the first
    } else if (variant.correctAnswerIndex > removedIndex) {
      variant.correctAnswerIndex -= 1;
    }
    renderActiveQuestion();
    scheduleAutoSync(q.id);
    return;
  }
});

// Scrolls Pane 2 to the <mark>(s) for this question's source ('question')
// or answer ('answer') snippet and briefly pulses them, independent of
// the persistent active-highlight state set by setActiveCard. A snippet
// that spans a block boundary (e.g. across two <li>s) was wrapped as
// multiple <mark> elements sharing the same qid/snippetType — every one
// of them gets pulsed so the whole highlighted run flashes together,
// even though only the first is scrolled into view.
// ---------------------------------------------------------------------
// Verbatim from source, lines 1646-1662
// ---------------------------------------------------------------------
function locateSnippetInDoc(qid, snippetType) {
  // HIGHLIGHT_DUPLICATE_SHARED_MARK_FIX_PROMPT.md: `~=` (word-match) so
  // this still finds a shared mark whose data-qid carries several ids.
  const marks = docTextContainer.querySelectorAll(
    `mark[data-qid~="${qid}"][data-snippet-type="${snippetType}"]`
  );
  if (!marks.length) return; // snippet didn't resolve to a highlight — nothing to jump to

  marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  marks.forEach(m => {
    m.classList.remove('locate-pulse');
    // Force reflow so re-adding the class restarts the animation even
    // if this same mark was just pulsed a moment ago.
    void m.offsetWidth;
    m.classList.add('locate-pulse');
  });
  setTimeout(() => marks.forEach(m => m.classList.remove('locate-pulse')), 1800);
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 1663-1669 (event wiring for this
// module's own nav element + the add/remove-duplicates buttons, which
// call straight into question-model.js's addQuestion/removeFlaggedDuplicates)
// ---------------------------------------------------------------------
questionNavEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-nav-id]');
  if (btn) setActiveCard(btn.dataset.navId);
});

// New (not from source) — Update 1 (paginated nav-chip bar): the
// pager's own numbered/Prev/Next buttons, plus Left/Right keyboard
// paging. Bound on questionNavGroup (the wrapper around both
// questionNav and questionNavPager) rather than `document`, so this
// only fires while focus is somewhere inside the Questions panel and
// doesn't compete with ArrowLeft/ArrowRight while typing in the active
// editor's text fields elsewhere on the page.
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
// ---------------------------------------------------------------------
// Verbatim from source, lines 1672-1685, except the `viaUserClick`
// param and the aiUnchecked-clearing/unchecked-highlight-toggle lines
// added by UNCHECKED_AI_CONTENT_AND_FUZZY_HIGHLIGHT_PERSISTENCE_PROMPT.md
// Part B (see comments below).
// ---------------------------------------------------------------------
// setActiveCard() is the single choke point every "view this question"
// path already goes through — nav chip click, Pane 3 mini-nav click,
// and clicking a highlight mark directly. `viaUserClick` (default
// true) distinguishes a real click from a programmatic auto-select —
// e.g. main.js selecting the first AI-generated question right after
// import/scan — so that a purely programmatic activation doesn't
// silently mark a question "checked" before the person has actually
// looked at it. Every existing call site (nav chip click, Pane 3
// mini-nav click, the docTextContainer mark-click listener in
// layout-formatting.js) keeps the default and is unaffected; a future
// call site can opt out by explicitly passing `false`.
function setActiveCard(id, viaUserClick = true) {
  const q = state.questions.find(x => x.id === id);
  // Clear the "unchecked" flag the moment the person actually views
  // this question, BEFORE renderQuestionNav()/renderActiveQuestion()
  // run below, so both immediately reflect the cleared state instead of
  // needing a second render pass to catch up.
  if (viaUserClick && q && q.aiUnchecked) {
    q.aiUnchecked = false;
  }

  // UPDATE 3: if a term filter is currently narrowing the chip grid and
  // the question being activated doesn't match it (e.g. the term bar's
  // own "View →" on a flagged duplicate under a DIFFERENT term than
  // whatever's currently filtered, or "jump to duplicate" landing on a
  // question with a different target term), clear the filter first —
  // otherwise the paging logic just below would compute a page position
  // within a filtered list this question isn't even part of, and the
  // chip for `id` could end up on a page that doesn't show it at all.
  if (activeTermFilterKey && q && normalizeTermKeyLoose(q.targetTerm || '') !== activeTermFilterKey) {
    activeTermFilterKey = null;
  }

  // New (not from source) — Update 1: bring the nav-chip pager to
  // whichever page the newly-active question lives on, so the
  // highlighted chip is never hidden behind a page the pager isn't
  // currently showing. setActiveCard() is the single choke point every
  // "view this question" path already goes through (see the comment
  // block above this function), so hooking in here covers nav chip
  // clicks, Pane 3 mini-nav clicks, highlight-mark clicks, and "jump to
  // duplicate" links in one place. Deliberately NOT done inside
  // renderQuestionNav() itself — that would also fire on the pager's
  // OWN Prev/Next/arrow-key navigation (which never calls
  // setActiveCard), pulling the person back to the active question's
  // page every time they tried to just browse.
  // UPDATE 3: paging is now computed against visibleQuestionEntries()
  // rather than state.questions directly, so this still lands on the
  // right page when a (still-matching) term filter is active.
  const entries = visibleQuestionEntries();
  const activeEntryIdx = entries.findIndex(({ q: eq }) => eq.id === id);
  if (activeEntryIdx !== -1) navChipPage = Math.floor(activeEntryIdx / NAV_CHIPS_PER_PAGE);

  state.activeCardId = id;
  renderQuestionNav();
  renderActiveQuestion();

  if (q) renderDocPage(q.sourcePage);

  // HIGHLIGHT_DUPLICATE_SHARED_MARK_FIX_PROMPT.md: a mark's data-qid can
  // now hold more than one id (a shared duplicate-pair mark — see the
  // multi-qid mark helpers in highlighting.js), so `m.dataset.qid === id`
  // would silently stop matching such a mark; read the full id list via
  // markQidList instead. For unchecked-highlight, a shared mark shows the
  // ring if ANY of the questions it belongs to still needs a first look
  // and isn't itself duplicate-suppressed.
  document.querySelectorAll('mark[data-qid]').forEach(m => {
    const ids = markQidList(m);
    m.classList.toggle('active-highlight', ids.includes(id));
    // Mirror each mark's unchecked state here too, same loop, so Pane 2
    // stays in sync with the nav-chip/badge indicator without a
    // separate DOM pass — same pattern used in
    // recheckHighlights()/recheckHighlightsForQuestion() (highlighting.js)
    // and renderTextVersion() (layout-formatting.js).
    // SUPPRESS_UNCHECKED_INDICATOR_FOR_DUPLICATES_PROMPT.md: `&&
    // !markDup` added — same suppression as the nav chip/badge above,
    // applied here too so a duplicate-flagged question's highlights
    // don't show the green outline either.
    const showUnchecked = ids.some(mid => {
      const markQ = state.questions.find(x => x.id === mid);
      const markDup = markQ && getDuplicateMap().get(markQ.id);
      return !!(markQ && markQ.aiUnchecked && !markDup);
    });
    m.classList.toggle('unchecked-highlight', showUnchecked);
  });
  const activeMark = docTextContainer.querySelector(`mark[data-qid~="${id}"]`);
  if (activeMark) activeMark.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export {
  escapeHtml,
  escapeAttr,
  buildNavChipHtml,
  renderQuestionNav,
  renderPane3QuestionNav,
  // UPDATE3_TERM_PANE_PROMPT.md: renderTermBar now also exported —
  // previously only called internally (from renderQuestionNav), but
  // doc-pane-navigation.js's renderSourcePage() needs to call it
  // directly too, to keep the "This page" scope's term list in sync
  // with Pane 3 page navigation (see that file for the call site).
  renderTermBar,
  // UPDATE3_TERM_PANE_PROMPT.md: exported for main.js's openSource() to
  // call — see this function's own comment above for why that wiring
  // isn't done yet in this pass.
  resetTermSearchOnSourceSwitch,
  variantIndexesOfGroup,
  variantTabsTemplate,
  choiceRowsTemplate,
  activeEditorTemplate,
  renderActiveQuestion,
  locateSnippetInDoc,
  setActiveCard,
};
