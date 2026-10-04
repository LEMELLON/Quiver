// field-sync.js
// FIELD SYNC (Field Sync + Question-Snippet Narrowing handoff, Batch 1).
//
// Keeps two derived fields in step with their snippets. Snippets are the source of truth (F1); sync copies snippet -> field.
//   term pair:     q.targetTerm            <- q.answerSnippet
//   question pair: clamp variant's text    <- q.questionSnippet + q.answerSnippet (answer blanked out of the question snippet)
// rephrased / true_false / category variants are never derived and never flagged (F2).
//
// NOT the dormant AI resync (AUTO_SYNC_ENABLED / handleResyncSnippets), NOT "Sync Highlights", NOT Pane 3's syncBadge.
// This is "field sync" everywhere (code, CSS classes, UI text, Update Log).
//
// Each pair carries a transient baseline on the question (q.syncBaseline, never exported by buildQuizObject):
//   { term: { snippet, field }, question: { snippet, field } }
// = the snippet-side key and the field value at the last moment they were aligned (creation, auto-follow, Sync, Keep mine).
//   snippet changed + field untouched since baseline -> reconcileFieldSync() auto-follows silently (F5)
//   field edited by hand since baseline              -> never overwritten; getFieldSyncState() reports 'desynced'
//
// Import cycles: cleanExtractedText / normalizeWhitespace are only called inside function bodies, never at module-evaluation
// time, so the cycles with snippet-question-generation.js / text-normalize.js are safe (same pattern as the rest of the codebase).
import { cleanExtractedText } from './snippet-question-generation.js';
import { normalizeWhitespace } from './text-normalize.js';

const PAIRS = ['term', 'question'];
const BLANK = '___';
const KEY_SEP = '\u0001'; // joins the two snippet strings in the question pair's snippet key (cannot occur in page text)
const LONG_TERM_LOG_LEN = 80; // F3: no length cap; derived terms longer than this are only logged

// ---------- small helpers ----------

// the first variant of type 'clamp' (Multiple Choice), else null
function getClampVariant(q) {
  const variants = q && Array.isArray(q.variants) ? q.variants : [];
  return variants.find(v => v && v.type === 'clamp') || null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Strips surrounding whitespace/quotes and trailing . , ; : (F3).
const TERM_LEADING_TRIM_RE = /^[\s"'`\u2018\u2019\u201C\u201D]+/;
const TERM_TRAILING_TRIM_RE = /[\s"'`\u2018\u2019\u201C\u201D.,;:]+$/;
function trimTermEdges(s) {
  return s.replace(TERM_LEADING_TRIM_RE, '').replace(TERM_TRAILING_TRIM_RE, '');
}

// ---------- derivation ----------

// F3. targetTerm <- cleanExtractedText(answerSnippet), edge-trimmed. null when there is no answer snippet. No length cap.
function deriveTargetTerm(q) {
  if (!q || !q.answerSnippet || !q.answerSnippet.trim()) return null;
  const term = trimTermEdges(cleanExtractedText(q.answerSnippet));
  return term || null;
}

// F4, with the reason when it can't be derived. Returns { text, occurrences } or { text: null, reason }.
// reason: 'no-question-snippet' | 'no-answer-snippet' | 'answer-outside' | 'answer-not-in-question'
function deriveQuestionInfo(q) {
  const questionSnippet = normalizeWhitespace(q && q.questionSnippet);
  const answerSnippet = normalizeWhitespace(q && q.answerSnippet);
  if (!questionSnippet) return { text: null, reason: 'no-question-snippet' };
  if (!answerSnippet) return { text: null, reason: 'no-answer-snippet' };
  if (q.answerScope === 'outside') return { text: null, reason: 'answer-outside' };

  // first occurrence: exact, then case-insensitive (a regex keeps indexes in the original string, unlike lowercasing both sides).
  // Batch 6: if the full answer isn't found, retry with its edges trimmed (same trim as F3), because a highlighted answer often carries
  // a trailing "." / "," / quote that the question snippet doesn't have at that spot.
  const candidates = [answerSnippet];
  const trimmed = trimTermEdges(answerSnippet);
  if (trimmed && trimmed !== answerSnippet) candidates.push(trimmed);

  for (const needle of candidates) {
    let index = questionSnippet.indexOf(needle);
    let length = needle.length;
    if (index === -1) {
      const m = new RegExp(escapeRegExp(needle), 'i').exec(questionSnippet);
      if (!m) continue;
      index = m.index;
      length = m[0].length;
    }
    const occurrences = (questionSnippet.match(new RegExp(escapeRegExp(needle), 'gi')) || []).length;
    return {
      text: questionSnippet.slice(0, index) + BLANK + questionSnippet.slice(index + length),
      occurrences,
    };
  }
  return { text: null, reason: 'answer-not-in-question' };
}

// F4. The clamp variant's question text <- questionSnippet with the first occurrence of answerSnippet replaced by ___.
// null when: no question snippet, no answer snippet, answerScope === 'outside', or the answer isn't inside the question snippet.
function deriveClampQuestionText(q) {
  return deriveQuestionInfo(q).text;
}

function deriveFor(q, pair) {
  return pair === 'term' ? deriveTargetTerm(q) : deriveClampQuestionText(q);
}

// Short human reason a pair can't be derived (for Batch 4's "Can't derive: ..." hint). '' when it can be derived.
function getUnderivableReason(q, pair) {
  if (pair === 'term') return deriveTargetTerm(q) === null ? 'there is no answer snippet' : '';
  const info = deriveQuestionInfo(q);
  if (info.text !== null) return '';
  switch (info.reason) {
    case 'no-question-snippet': return 'there is no question snippet';
    case 'no-answer-snippet': return 'there is no answer snippet';
    case 'answer-outside': return 'the answer is outside the source';
    default: return 'the answer isn\u2019t inside the question snippet';
  }
}

// ---------- baseline model ----------

// current { snippet, field } keys for one pair (normalized strings only)
function currentKeys(q, pair) {
  if (pair === 'term') {
    return { snippet: normalizeWhitespace(q.answerSnippet), field: normalizeWhitespace(q.targetTerm) };
  }
  const clamp = getClampVariant(q);
  return {
    snippet: normalizeWhitespace(q.questionSnippet) + KEY_SEP + normalizeWhitespace(q.answerSnippet),
    field: clamp ? normalizeWhitespace(clamp.questionText) : '',
  };
}

function hasValidBaseline(q) {
  const b = q && q.syncBaseline;
  return !!b && PAIRS.every(p => b[p] && typeof b[p].snippet === 'string' && typeof b[p].field === 'string');
}

// Sets q.syncBaseline from the current values (creation, or lazily for a question that has none).
function initFieldSyncBaseline(q) {
  q.syncBaseline = { term: currentKeys(q, 'term'), question: currentKeys(q, 'question') };
}

function resetPairBaseline(q, pair) {
  if (!hasValidBaseline(q)) { initFieldSyncBaseline(q); return; }
  q.syncBaseline[pair] = currentKeys(q, pair);
}

// ---------- state ----------

// Pure apart from creating a missing baseline. Returns { state, derived }:
//   'synced' | 'desynced' | 'underivable' | 'none' (question pair only, no clamp variant)
function getFieldSyncState(q, pair) {
  if (!hasValidBaseline(q)) initFieldSyncBaseline(q); // lazy: a question with no baseline is never flagged
  if (pair === 'question' && !getClampVariant(q)) return { state: 'none', derived: null };

  const derived = deriveFor(q, pair);
  const base = q.syncBaseline[pair];
  const cur = currentKeys(q, pair);

  // Batch 6: an EMPTY field that can be derived is never "in sync", whatever the baseline says (a baseline taken while the snippets
  // already existed, e.g. a question created from a highlight, used to hide this and show no Sync button).
  if (derived !== null && cur.field === '') return { state: 'desynced', derived };
  if (cur.snippet === base.snippet && cur.field === base.field) return { state: 'synced', derived };
  if (derived !== null && normalizeWhitespace(derived) === cur.field) return { state: 'synced', derived };
  return { state: derived !== null ? 'desynced' : 'underivable', derived };
}

// ---------- writing ----------

function writeField(q, pair, value) {
  if (pair === 'term') { q.targetTerm = value; return; }
  const clamp = getClampVariant(q);
  if (clamp) clamp.questionText = value;
}

// F3 / F4 notes: logged where a derived value is written (not in the pure derivations, which run on every render).
function logDerivationNotes(q, pair, value) {
  if (pair === 'term' && value.length > LONG_TERM_LOG_LEN) {
    console.log('[field-sync] derived target term is long (' + value.length + ' chars) — list-style answer?', { qid: q.id });
  } else if (pair === 'question') {
    const info = deriveQuestionInfo(q);
    if (info.text !== null && info.occurrences > 1) {
      console.log('[field-sync] answer occurs ' + info.occurrences + ' times in the question snippet; only the first was blanked', { qid: q.id });
    }
  }
}

// Auto-follow (F5). For each pair: snippet key changed + field untouched since baseline + derivable -> write the derived value and
// reset that pair's baseline. Snippet unchanged or field hand-edited -> do nothing. A missing baseline is created from the current
// values and nothing follows. Returns which fields' text actually changed so callers know what to re-render.
// An empty untouched field plus a derivable value fills it (the "new question from selection" flow).
function reconcileFieldSync(q) {
  const result = { termChanged: false, questionChanged: false };
  if (!q) return result;
  if (!hasValidBaseline(q)) { initFieldSyncBaseline(q); return result; }

  for (const pair of PAIRS) {
    if (pair === 'question' && !getClampVariant(q)) continue;
    const base = q.syncBaseline[pair];
    const cur = currentKeys(q, pair);
    if (cur.snippet === base.snippet) continue; // snippet side unchanged
    if (cur.field !== base.field) continue;     // field edited by hand — never overwrite
    const derived = deriveFor(q, pair);
    if (derived === null) continue;             // underivable — leave the field, the state function reports it

    const before = pair === 'term' ? q.targetTerm : getClampVariant(q).questionText;
    writeField(q, pair, derived);
    resetPairBaseline(q, pair);
    if (before !== derived) {
      if (pair === 'term') result.termChanged = true; else result.questionChanged = true;
      logDerivationNotes(q, pair, derived);
    }
  }
  return result;
}

// "↻ Sync from snippet": overwrite the field with the derived value and reset the baseline. false (no-op) when nothing to derive.
function applyFieldSync(q, pair) {
  if (!q || (pair === 'question' && !getClampVariant(q))) return false;
  const derived = deriveFor(q, pair);
  if (derived === null) return false;

  const before = pair === 'term' ? q.targetTerm : getClampVariant(q).questionText;
  writeField(q, pair, derived);
  resetPairBaseline(q, pair);
  const changed = before !== derived;
  if (changed) logDerivationNotes(q, pair, derived);
  return changed;
}

// F8 "Keep mine": accept the hand edit — reset the baseline to the current values. Changes no text.
function keepFieldAsIs(q, pair) {
  if (!q) return;
  resetPairBaseline(q, pair);
}

export {
  getClampVariant,
  deriveTargetTerm,
  deriveClampQuestionText,
  getUnderivableReason,
  initFieldSyncBaseline,
  getFieldSyncState,
  reconcileFieldSync,
  applyFieldSync,
  keepFieldAsIs,
};
