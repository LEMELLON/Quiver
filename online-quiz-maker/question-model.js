// question-model.js
// Extracted verbatim from online-quiz-maker.html (source lines 858-1082
// for the main functions, plus DUPLICATE_SNIPPET_MIN_LEN at line 1991 and
// answerKeyOf/computeDuplicateMap at lines 2002-2046, which live further
// down the file but are pure question-data operations and belong in this
// module per the schema).
// Function/const bodies are UNCHANGED from source — only import/export
// wrapper lines were added. See the two NOTE blocks below for the two
// spots where ES-module mechanics required a small, clearly-flagged
// structural addition (not a logic change) to keep shared state working
// across module boundaries.

// --- Shared dependencies ---
import { state } from './core-state.js';
import { activeEditorEl, questionCountEl } from './dom-refs.js';

// NOTE (structural, not a logic change): TIER_META, VERIFY_META, and
// DATA_STATUS_META were originally declared inline in this section of the
// source (lines 877, 892, 920) but are also read by editor-render.js
// (line 1320-1321), highlighting.js (line 2240), and
// snippet-question-generation.js (line 3820). Since more than one module
// needs them, they've been lifted verbatim into a shared
// classification-meta.js module instead of being duplicated here. Their
// contents are byte-for-byte identical to the source — nothing about the
// objects themselves was changed, only which file declares them.
import { DATA_STATUS_META } from './classification-meta.js';

// Functions from other modules that these functions call:
import { setActiveCard, renderActiveQuestion } from './editor-render.js';
// renderQuestionNav is also called by deleteQuestion/removeFlaggedDuplicates
import { renderQuestionNav } from './editor-render.js';
// renderTextVersion is called by deleteQuestion/removeFlaggedDuplicates
import { renderTextVersion } from './layout-formatting.js';
import { normalizeTermKey, normalizeTermKeyLoose } from './text-normalize.js';

// NOTE (structural, not a logic change): `duplicateMap` (source line 2051)
// is a module-level `let` that source code reassigns from BOTH this
// module's removeFlaggedDuplicates() AND from editor-render.js's
// renderQuestionNav()/renderPane3QuestionNav(). Plain ES imports are
// read-only bindings, so a module that only `import`s duplicateMap cannot
// do `duplicateMap = ...` the way the original single-scope code did.
// To keep every read/write site working without touching the logic
// inside any function, duplicateMap now lives in core-state.js with a
// getter/setter pair, and the two assignment sites
// (`duplicateMap = computeDuplicateMap();`) become
// `setDuplicateMap(computeDuplicateMap());` — the only textual change in
// this whole extraction, and it's mechanical (required by ES module
// semantics), not a rewrite of behavior.
import { getDuplicateMap, setDuplicateMap } from './core-state.js';

// ---------------------------------------------------------------------
// Verbatim from source, lines 858-870
// ---------------------------------------------------------------------
function newVariant(type) {
  return {
    type,
    questionText: '',
    choices: type === 'true_false' ? ['True', 'False'] : ['', '', '', ''],
    correctAnswerIndex: 0,
    // Category Selection is checkbox-style (0+ correct choices) rather
    // than radio-style (exactly 1) — correctAnswerIndices holds the set
    // of correct choice indexes for that type only; every other type
    // keeps using correctAnswerIndex above and leaves this undefined.
    correctAnswerIndices: type === 'category' ? [] : undefined,
  };
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 926-931
// ---------------------------------------------------------------------
function computeDataClassification(q) {
  const hasSource = !!(q.sourceSnippet && q.sourceSnippet.trim());
  const hasAnswer = !!(q.answerSnippet && q.answerSnippet.trim());
  if (!hasSource || !hasAnswer) return 'unclassified';
  return (q.sourceFound !== false && q.answerFound !== false) ? 'verified' : 'unverified';
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 933-965
// ---------------------------------------------------------------------
function newQuestion() {
  state.idCounter += 1;
  return {
    id: 'q_' + state.idCounter,
    sourcePage: state.currentPage || 1,
    // UPDATE 2A: which state.sources[] entry this question belongs to —
    // null if added before any document was ever imported (state.
    // activeSourceId is null until the first source exists). See the
    // matching additions in ai-api-calls.js's parseAiQuestions() and
    // snippet-question-generation.js, and sortQuestionsByPage() below,
    // which now sorts by this field first.
    sourceId: state.activeSourceId,
    sourceSnippet: '',   // question-context passage (highlighted by tier color)
    answerSnippet: '',   // exact answer/target-term substring (highlighted green)
    targetTerm: '',
    tier: 1,             // 1 | 2 | 3 — manually-added questions default to top-tier
    verifyTier: 1,        // 1-4 — verification status, reassessed by recheckHighlights
    // Whether sourceSnippet/answerSnippet are currently locatable in the
    // document — set true the moment either is freshly (re)matched by
    // an AI snippet-generation/scan path, and set false only when the
    // recheck ladder truly fails to find it anywhere. Feeds
    // computeDataClassification() above; irrelevant while the
    // corresponding snippet is still blank.
    sourceFound: false,
    answerFound: false,
    definitionType: 'new', // 'new' | 'extension'
    // UNCHECKED_AI_CONTENT_AND_FUZZY_HIGHLIGHT_PERSISTENCE_PROMPT.md
    // Part B — whether this question is AI-autogenerated and hasn't
    // been viewed yet (drives the green "unchecked" nav-chip/badge/
    // highlight indicator, cleared by setActiveCard() on view). A
    // manually-added question via "+ Add Question" needs no review
    // flag — the person is creating it themselves — so it always
    // starts false here; parseAiQuestions() in ai-api-calls.js is the
    // one place that sets it true.
    aiUnchecked: false,
    activeVariantIndex: 0,
    variants: [newVariant('clamp')], // rephrased/true_false are generated on demand — see note above
    generatingType: null,
    variantGenError: null,
    // Transient UI-only state for the per-question "AI: choices",
    // "resync snippets", and "recheck this question" buttons below —
    // same treatment as generatingType/variantGenError above, never
    // persisted to export (see buildQuizObject's explicit whitelist).
    choicesBusy: false,
    choicesError: null,
    snippetBusy: false,
    snippetError: null,
    // Transient UI-only state for the per-field "🔎 Scan question" /
    // "🔎 Scan answer" buttons — manual scan-from-highlight, see
    // handleScanField below. Just an error message; there's no "busy"
    // state anymore since capturing the current highlight is instant.
    scanError: null,
  };
}

// Strips a leading occurrence of `term` (tolerating a leading article —
// "a"/"an"/"the" — glued onto it, case-insensitively) from the front of
// `sentence` and returns a fill-in-the-blank prompt with a blank in its
// place, e.g. toClampPrompt("A computer is an electronic machine...",
// "computer") -> "___ is an electronic machine...". If the term isn't
// found at the very start (the AI didn't phrase it term-first), a blank
// is still prefixed so a usable prompt is always produced rather than
// silently dropping the variant.
// ---------------------------------------------------------------------
// Verbatim from source, lines 980-992
// ---------------------------------------------------------------------
function toClampPrompt(sentence, term) {
  const cleanSentence = (sentence || '').trim();
  if (!cleanSentence) return '';
  const cleanTerm = (term || '').trim();
  if (!cleanTerm) return cleanSentence;
  const escapedTerm = cleanTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const leadingTermPattern = new RegExp('^(?:the|an?)\\s+' + escapedTerm + '\\b\\s*|^' + escapedTerm + '\\b\\s*', 'i');
  const match = cleanSentence.match(leadingTermPattern);
  if (match) {
    return '___ ' + cleanSentence.slice(match[0].length);
  }
  return '___ ' + cleanSentence;
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 994-1005
// ---------------------------------------------------------------------
function addQuestion() {
  const q = newQuestion();
  state.questions.push(q);
  sortQuestionsByPage();
  setActiveCard(q.id);
  updateQuestionCount();
  // Focus the question text field once it's rendered.
  requestAnimationFrame(() => {
    const el = activeEditorEl.querySelector('[data-field="questionText"]');
    if (el) el.focus();
  });
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 1007-1017
// ---------------------------------------------------------------------
function deleteQuestion(id) {
  state.questions = state.questions.filter(q => q.id !== id);
  if (state.activeCardId === id) {
    const fallback = state.questions[state.questions.length - 1];
    state.activeCardId = fallback ? fallback.id : null;
  }
  renderQuestionNav();
  renderActiveQuestion();
  updateQuestionCount();
  renderTextVersion(); // drop the now-orphaned highlight, if any
}

// Bulk-deletes every question currently flagged as a possible duplicate
// by computeDuplicateMap() -- i.e. every id that appears as the "b" side
// of a match -- EXCEPT ones classified as an Extension. computeDuplicateMap()
// is what assigns that classification in the first place (see its
// same-source/different-answer check above), so recomputing it here
// first guarantees this reads the current classification rather than a
// possibly-stale one left over from the last render.
// ---------------------------------------------------------------------
// Verbatim from source, lines 1026-1044, EXCEPT the single mechanical
// `duplicateMap = computeDuplicateMap();` -> `setDuplicateMap(...)`
// change described in the NOTE above.
// ---------------------------------------------------------------------
function removeFlaggedDuplicates() {
  setDuplicateMap(computeDuplicateMap());
  const idsToRemove = new Set();
  for (const qid of getDuplicateMap().keys()) {
    const q = state.questions.find(x => x.id === qid);
    if (q && q.definitionType === 'extension') continue;
    idsToRemove.add(qid);
  }
  if (idsToRemove.size === 0) return;

  const removingActive = state.activeCardId !== null && idsToRemove.has(state.activeCardId);
  state.questions = state.questions.filter(q => !idsToRemove.has(q.id));
  if (removingActive) {
    const fallback = state.questions[state.questions.length - 1];
    state.activeCardId = fallback ? fallback.id : null;
  }
  renderQuestionNav();
  renderActiveQuestion();
  updateQuestionCount();
  renderTextVersion(); // drop any now-orphaned highlight
}

// Removes a single variation from a question collection — any type,
// including the clamp (Multiple Choice) base, as long as it isn't the
// last variant left on the question (a question always needs at least
// one variant to stay valid/exportable).
// ---------------------------------------------------------------------
// Verbatim from source, lines 1052-1064
// ---------------------------------------------------------------------
function removeVariant(qid, variantIndex) {
  const q = state.questions.find(x => x.id === qid);
  if (!q) return;
  const variant = q.variants[variantIndex];
  if (!variant || q.variants.length <= 1) return;

  q.variants.splice(variantIndex, 1);
  if (q.activeVariantIndex === variantIndex) {
    // Land on whatever's now first — simplest, always-valid choice
    // regardless of which group it belongs to.
    q.activeVariantIndex = 0;
  } else if (q.activeVariantIndex > variantIndex) {
    q.activeVariantIndex -= 1; // keep pointing at the same variant after the splice shift
  }
  renderActiveQuestion();
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 1069-1072
// ---------------------------------------------------------------------
function updateQuestionCount() {
  const n = state.questions.length;
  questionCountEl.textContent = n + (n === 1 ? ' question' : ' questions');
}

// Keeps state.questions ordered ascending by sourcePage (stable for ties,
// so questions drawn from the same page keep their relative order) —
// this is what drives the Q01/Q02/... numbering in the nav chips and
// active editor title.
// ---------------------------------------------------------------------
// Verbatim from source, lines 1078-1080, EXCEPT the comparator is now a
// compound sort — see UPDATE 2A note below.
// ---------------------------------------------------------------------
// UPDATE 2A: with multiple documents, sourcePage alone is ambiguous —
// page 3 of source A and page 3 of source B would previously interleave
// arbitrarily. Sort primarily by each question's source's position in
// state.sources (i.e. import/reorder order — Update 2B's drag UI is
// what lets a person change that order; for 2A it's simply append
// order), THEN by sourcePage within that source, exactly as before.
// Array.prototype.sort is spec-guaranteed stable (ES2019+), so ties on
// both keys still keep their prior relative order, same as the original
// single-key sort did. A question with no matching source (sourceId
// null/stale — e.g. added via "+ Add Question" before any import)
// sorts first, via indexOf's -1.
// ---------------------------------------------------------------------
function sortQuestionsByPage() {
  state.questions.sort((a, b) => {
    const orderA = state.sources.findIndex(s => s.id === a.sourceId);
    const orderB = state.sources.findIndex(s => s.id === b.sourceId);
    if (orderA !== orderB) return orderA - orderB;
    return (a.sourcePage || 0) - (b.sourcePage || 0);
  });
}

// ---------------------------------------------------------------------
// Verbatim from source, line 1991
// ---------------------------------------------------------------------
const DUPLICATE_SNIPPET_MIN_LEN = 20; // below this, a snippet overlap is too short to be meaningful on its own

// compared: if the two questions cite the same passage but key to a
// different answer (answerSnippet, falling back to targetTerm when no
// snippet was captured), the later one isn't a repeat of the earlier
// one -- it's elaborating on a different detail within that same
// passage. That pattern is exactly what "extension" means elsewhere in
// this file (see the PASS 2 definitionType rules above), so it gets
// reclassified as one here too, on the fly, any time the duplicate map
// is recomputed -- not just for AI-generated collections.
// ---------------------------------------------------------------------
// Verbatim from source, lines 2002-2004
// ---------------------------------------------------------------------
function answerKeyOf(q) {
  return normalizeTermKey(q.answerSnippet || q.targetTerm || '');
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 2006-2046
// ---------------------------------------------------------------------
function computeDuplicateMap() {
  const map = new Map(); // qid -> { matchId, matchIndex, reason }
  const qs = state.questions;
  for (let i = 0; i < qs.length; i++) {
    const b = qs[i];
    if (map.has(b.id)) continue;
    if (b.dupeDismissed) continue; // person explicitly cleared this one's flag — leave it alone
    const termB = normalizeTermKeyLoose(b.targetTerm || '');
    const snipB = b.sourceSnippet ? normalizeTermKey(b.sourceSnippet) : '';
    for (let j = 0; j < i; j++) {
      const a = qs[j];
      let reason = null;

      const termA = normalizeTermKeyLoose(a.targetTerm || '');
      if (termA && termB && termA === termB) {
        reason = 'same target term';
      } else if (a.sourcePage === b.sourcePage && a.sourceSnippet && b.sourceSnippet) {
        const snipA = normalizeTermKey(a.sourceSnippet);
        if (snipA && snipB) {
          const shorter = snipA.length <= snipB.length ? snipA : snipB;
          const longer = snipA.length <= snipB.length ? snipB : snipA;
          if (shorter.length >= DUPLICATE_SNIPPET_MIN_LEN && longer.includes(shorter)) {
            reason = 'same source passage';
            const answerA = answerKeyOf(a);
            const answerB = answerKeyOf(b);
            if (answerA && answerB && answerA !== answerB && b.definitionType !== 'extension') {
              b.definitionType = 'extension';
            }
          }
        }
      }

      if (reason) {
        map.set(b.id, { matchId: a.id, matchIndex: j, reason });
        break;
      }
    }
  }
  return map;
}

export {
  newVariant,
  computeDataClassification,
  newQuestion,
  toClampPrompt,
  addQuestion,
  deleteQuestion,
  removeFlaggedDuplicates,
  removeVariant,
  updateQuestionCount,
  sortQuestionsByPage,
  answerKeyOf,
  computeDuplicateMap,
};
