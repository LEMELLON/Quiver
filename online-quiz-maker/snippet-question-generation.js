import { state, getPendingSelection, getLastDocSelection, setLastDocSelection } from './core-state.js';
import {
  docTextContainer,
  selectionGenerateBtn,
  selectionQuestionType,
} from './dom-refs.js';

import { fuzzyIncludes, findSnippetRange, selectionRangeIdx, computeOccurrenceIndex, recheckHighlightsForQuestion } from './highlighting.js';
import { callAi, ensureProviderReady, isProviderConfigured } from './ai-provider.js';
import { safeParseAIJson } from './ai-prompt-builders.js';
import { handleApiError } from './variant-generation.js';
import { renderQuestionNav, renderActiveQuestion, setActiveCard } from './editor-render.js';
import { renderTextVersion } from './layout-formatting.js';
import { newQuestion, newVariant, updateQuestionCount, sortQuestionsByPage, isContainedIn } from './question-model.js';
import { AUTO_SYNC_ENABLED } from './shared-constants.js';
import { hideSelectionToolbar } from './selection-toolbar.js';
// Field sync (Batch 3): only called inside function bodies, never at module-evaluation time, so the import cycle is safe.
import { reconcileFieldSync } from './field-sync.js';
import { setSelectionGenStatus } from './status-helpers.js';

// System prompt used by resyncSnippetsForQuestion (dormant while AUTO_SYNC_ENABLED is false). The SOURCE snippet is authoritative and fixed:
// the AI only re-picks the question and answer snippets from inside it.
const RESYNC_SNIPPET_SYSTEM_PROMPT = `You are a quiz-writing assistant embedded in a document-to-quiz tool. You'll be given one fixed SOURCE passage, plus an existing quiz question (its target term and question text, and optionally its current choices/correct answer) that was written FROM that passage. The person has just edited the question and/or its answer, so your job is to re-locate, INSIDE the given source passage, the question passage and the answer as the question NOW reads.

Rules (follow strictly):
1. VERBATIM ONLY: "questionSnippet" and "answerSnippet" must each be an exact, character-for-character substring of the given source passage (same spelling, spacing, punctuation) — never paraphrase, summarize, or invent text that isn't literally there.
2. "questionSnippet" is the narrower passage inside the source that the question is drawn from (a sentence, or a sentence plus the list it introduces).
3. "answerSnippet" is the narrowest exact substring — normally inside questionSnippet — that states the correct answer/target term as edited. If the correct answer is an enumerated list, cover that whole list.
4. The source passage itself never changes; do not return it.
5. If nothing in the source supports the edited question/answer, return empty strings rather than guessing.
6. OUTPUT FORMAT: reply with ONLY a single JSON object, no markdown code fences, no commentary:
{
"questionSnippet": "string — exact verbatim substring of the source passage, or \"\" if none fits",
"answerSnippet": "string — exact verbatim substring of the source passage, or \"\" if none fits"
}`;

// Re-picks an edited question's question/answer snippets inside its fixed source snippet via AI; returns {questionSnippet, answerSnippet}, never mutates q.
async function resyncSnippetsForQuestion(q) {
  ensureProviderReady();
  if (!q.sourceSnippet || !q.sourceSnippet.trim()) {
    throw new Error('This question has no source snippet yet — scan one first.');
  }
  const sourceText = cleanExtractedText(q.sourceSnippet);

  const variant = q.variants[q.activeVariantIndex] || q.variants[0];
  const choicesBlock = variant && Array.isArray(variant.choices) && variant.choices.some(c => c.trim())
    ? `\nCurrent choices: ${JSON.stringify(variant.choices)}, correct: ${JSON.stringify(variant.choices[variant.correctAnswerIndex] ?? '')}`
    : '';
  const userPrompt = `Source passage (page ${q.sourcePage}):
"""
${sourceText}
"""

Existing question (already edited by the person — re-sync to THIS, don't second-guess it):
Target term: "${q.targetTerm || '(not given)'}"
Question text: "${variant ? variant.questionText : ''}"${choicesBlock}

Return only the JSON object.`;

  let rawText;
  try {
    rawText = await callAi(RESYNC_SNIPPET_SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    if (handleApiError(err, null)) {
      throw new Error('⚠ API Quota Exceeded or Rate Limited. You have run out of API usage or are making requests too quickly.');
    }
    throw err;
  }

  let parsed;
  try { parsed = safeParseAIJson(rawText); } catch (e) { parsed = null; }
  if (!parsed || typeof parsed !== 'object') throw new Error('The AI response was not usable. Try again.');

  const rawQuestion = typeof parsed.questionSnippet === 'string' ? parsed.questionSnippet : '';
  const rawAnswer = typeof parsed.answerSnippet === 'string' ? parsed.answerSnippet : '';
  const questionSnippet = fuzzyIncludes(sourceText, rawQuestion) ? rawQuestion : '';
  const answerSnippet = fuzzyIncludes(sourceText, rawAnswer) ? rawAnswer : '';

  if (!questionSnippet && !answerSnippet) {
    throw new Error('Could not find a matching passage inside the source for the edited question/answer.');
  }
  return { questionSnippet, answerSnippet };
}

// Runs resyncSnippetsForQuestion for one question and applies the result, preserving any slot the AI didn't find a fresh match for.
// The source snippet is never touched, and an 'outside' answer is left alone (it doesn't live in the source).
async function handleResyncSnippets(qid) {
  const q = state.questions.find(x => x.id === qid);
  if (!q || q.snippetBusy) return;

  q.snippetBusy = true;
  q.snippetError = null;
  renderActiveQuestion();

  try {
    const result = await resyncSnippetsForQuestion(q);
    const preserved = [];

    if (result.questionSnippet) {
      q.questionSnippet = result.questionSnippet;
      q.questionFound = true;
      q.questionOccurrence = 0;
    } else {
      preserved.push('question');
    }

    if (q.answerScope === 'outside') {
      preserved.push('answer (outside source — left alone)');
    } else if (result.answerSnippet) {
      q.answerSnippet = result.answerSnippet;
      q.answerFound = true;
      q.answerOccurrence = 0;
    } else {
      preserved.push('answer');
    }

    if (preserved.length) {
      q.snippetError = `${preserved[0]}: kept the existing snippet`;
    }
    reconcileFieldSync(q); // field sync: untouched target term / clamp question text follow the new snippets (before any re-render)
    recheckHighlightsForQuestion(qid, { force: true });
    renderQuestionNav();
  } catch (err) {
    console.error('[handleResyncSnippets] failed', err);
    q.snippetError = err.message || 'Failed to resync snippets.';
  } finally {
    q.snippetBusy = false;
    renderActiveQuestion();
    if (q.snippetError) {
      setTimeout(() => {
        if (q.snippetError) {
          q.snippetError = null;
          if (state.activeCardId === qid) renderActiveQuestion();
        }
      }, 5000);
    }
  }
}

// ---------- Scanning snippets from a Pane 2 selection ----------

// Shows a scan/edit problem or notice on the question for a while; the state is left untouched by callers that use this to reject.
function setScanMessage(q, message, ms = 6000) {
  q.scanError = message;
  renderActiveQuestion();
  setTimeout(() => {
    if (q.scanError === message) {
      q.scanError = null;
      if (state.activeCardId === q.id) renderActiveQuestion();
    }
  }, ms);
}

function pageBodyEl(pageNum) {
  return docTextContainer.querySelector(`.doc-page[data-page="${pageNum}"] .doc-page-body`);
}

// Checks a live selection against a question's source: DOM check first (selection within the source's range on the same page, so the
// right occurrence is validated), then fuzzyIncludes on the text when the DOM can't decide (stale Range, source not located).
// Returns { ok, body, srcRange, selIdx }.
function checkSelectionInsideSource(q, sel) {
  if (sel.sourceId && sel.sourceId !== q.sourceId) return { ok: false };
  if (sel.sourcePage !== q.sourcePage) return { ok: false };
  const body = pageBodyEl(q.sourcePage);
  const srcRange = body ? findSnippetRange(body, q.sourceSnippet, null, q.sourceOccurrence) : null;
  const selIdx = body ? selectionRangeIdx(body, sel.range) : null;
  if (srcRange && selIdx) {
    return { ok: selIdx.startIdx >= srcRange.startIdx && selIdx.endIdx <= srcRange.endIdx, body, srcRange, selIdx };
  }
  return { ok: fuzzyIncludes(q.sourceSnippet, sel.text), body, srcRange, selIdx: null };
}

function finishScan(q) {
  window.getSelection().removeAllRanges();
  setLastDocSelection(null);
  hideSelectionToolbar();
  // Field sync: untouched target term / clamp question text follow the new snippets. Runs BEFORE the recheck and the re-renders
  // below so the nav chips (term), duplicate map and editor all render the new values.
  reconcileFieldSync(q);
  recheckHighlightsForQuestion(q.id, { force: true });
  renderQuestionNav();
  renderActiveQuestion();
}

// Drops the most recently highlighted Pane 2 text into one slot (source / question / answer) of a question.
// question/answer must sit inside the source snippet (rejected otherwise, no state change); source replaces the source (D5).
function handleScanField(qid, fieldType) {
  const q = state.questions.find(x => x.id === qid);
  if (!q) return;

  const sel = getLastDocSelection();
  if (!sel || !sel.text) {
    const what = fieldType === 'source' ? 'source passage' : fieldType === 'answer' ? 'answer' : 'question passage';
    setScanMessage(q, `Highlight the ${what} in the document text (Pane 2) first, then click "Scan ${fieldType}" again.`, 5000);
    return;
  }

  if (fieldType === 'source') {
    const body = pageBodyEl(sel.sourcePage);
    const occurrence = body ? computeOccurrenceIndex(body, null, sel.text, sel.range) : 0;
    const newSourceId = sel.sourceId || state.activeSourceId;

    // An 'outside' answer with no explicit page was pinned to the old source page; keep it there when the source moves.
    if (q.answerScope === 'outside' && q.answerPage == null) q.answerPage = q.sourcePage;

    q.scanError = null;
    q.sourceSnippet = sel.text;
    q.sourcePage = sel.sourcePage;
    const sourceFileChanged = q.sourceId !== newSourceId;
    q.sourceId = newSourceId;
    q.sourceFound = true;
    q.sourceOccurrence = occurrence;

    // D5: re-validate children against the new source; anything no longer valid is cleared with a visible notice.
    const cleared = [];
    if (q.questionSnippet && !isContainedIn(q.questionSnippet, q.sourceSnippet)) {
      q.questionSnippet = ''; q.questionFound = false; cleared.push('question snippet');
    }
    q.questionOccurrence = 0;
    if (q.answerSnippet) {
      if (q.answerScope === 'outside') {
        if (sourceFileChanged) {
          q.answerSnippet = ''; q.answerFound = false; q.answerScope = 'inside'; q.answerPage = null; q.answerOccurrence = 0;
          cleared.push('answer snippet (it belonged to the previous document)');
        }
      } else {
        if (!isContainedIn(q.answerSnippet, q.sourceSnippet)) {
          q.answerSnippet = ''; q.answerFound = false; cleared.push('answer snippet');
        }
        q.answerOccurrence = 0;
      }
    }
    if (q.editingField) { q.editingField = null; q.editDraft = ''; }

    sortQuestionsByPage();
    finishScan(q);
    if (cleared.length) {
      setScanMessage(q, `Source replaced — cleared the ${cleared.join(' and ')} because ${cleared.length > 1 ? 'they are' : 'it is'} no longer valid for the new source. Scan again.`, 9000);
    }
    return;
  }

  // question / answer: must be inside the source (and never changes sourcePage / sourceId)
  if (!q.sourceSnippet) {
    setScanMessage(q, 'This question has no source snippet yet — scan the source first.');
    return;
  }
  const check = checkSelectionInsideSource(q, sel);
  if (!check.ok) {
    setScanMessage(q, fieldType === 'answer'
      ? 'That selection is not inside this question\u2019s source snippet. Select the answer inside the source, or use \u201C\u2795 Answer outside source\u201D if it is named elsewhere in the document.'
      : 'That selection is not inside this question\u2019s source snippet. Select the question passage inside the source.');
    return;
  }

  q.scanError = null;
  if (fieldType === 'question') {
    // occurrence is counted inside the source range, matching how the highlight engine resolves it
    q.questionSnippet = sel.text;
    q.questionFound = true;
    q.questionOccurrence = (check.body && check.srcRange) ? computeOccurrenceIndex(check.body, check.srcRange, sel.text, sel.range) : 0;
  } else {
    // answer: relative to the question range when the selection sits inside it, otherwise relative to the source range
    let parent = check.srcRange || null;
    if (check.body && q.questionSnippet) {
      const qRange = findSnippetRange(check.body, q.questionSnippet, check.srcRange, q.questionOccurrence);
      const inQuestion = qRange && (check.selIdx
        ? check.selIdx.startIdx >= qRange.startIdx && check.selIdx.endIdx <= qRange.endIdx
        : fuzzyIncludes(q.questionSnippet, sel.text));
      if (inQuestion) parent = qRange;
    }
    q.answerSnippet = sel.text;
    q.answerScope = 'inside';
    q.answerPage = null;
    q.answerFound = true;
    q.answerOccurrence = (check.body && parent) ? computeOccurrenceIndex(check.body, parent, sel.text, sel.range) : 0;
  }
  finishScan(q);
}

// "➕ Answer outside source": the answer lives elsewhere in the SAME document (e.g. a term named once on an earlier page).
function handleScanAnswerOutside(qid) {
  const q = state.questions.find(x => x.id === qid);
  if (!q) return;

  const sel = getLastDocSelection();
  if (!sel || !sel.text) {
    setScanMessage(q, 'Highlight the answer in the document text (Pane 2) first, then click \u201C\u2795 Answer outside source\u201D again.', 5000);
    return;
  }
  if (sel.sourceId && sel.sourceId !== q.sourceId) {
    setScanMessage(q, 'An answer outside the source must come from the same document as this question.');
    return;
  }

  const body = pageBodyEl(sel.sourcePage);
  q.scanError = null;
  q.answerSnippet = sel.text;
  q.answerScope = 'outside';
  q.answerPage = sel.sourcePage;
  q.answerFound = true;
  q.answerOccurrence = body ? computeOccurrenceIndex(body, null, sel.text, sel.range) : 0; // relative to that whole page
  finishScan(q);
}

// ---------- Editing question / answer snippets by hand (the source snippet is read-only) ----------

function startSnippetEdit(qid, field) {
  const q = state.questions.find(x => x.id === qid);
  if (!q || (field !== 'question' && field !== 'answer')) return;
  q.editingField = field;
  q.editDraft = field === 'question' ? q.questionSnippet : q.answerSnippet;
  q.scanError = null;
  renderActiveQuestion();
  requestAnimationFrame(() => {
    const el = document.querySelector(`textarea[data-snippet-edit="${field}"]`);
    if (el) el.focus();
  });
}

function cancelSnippetEdit(qid) {
  const q = state.questions.find(x => x.id === qid);
  if (!q) return;
  q.editingField = null;
  q.editDraft = '';
  q.scanError = null;
  renderActiveQuestion();
}

// true if `text` is present on pageNum of the question's own source file
function textOnPage(q, pageNum, text) {
  const source = state.sources.find(s => s.id === q.sourceId);
  const page = source ? source.pages.find(p => p.pageNumber === pageNum) : null;
  return !!page && fuzzyIncludes(cleanExtractedText(page.text), text);
}

// Validates and commits an edited question/answer snippet. Invalid text is refused (old value kept, editor stays open with the message).
function saveSnippetEdit(qid, field) {
  const q = state.questions.find(x => x.id === qid);
  if (!q || q.editingField !== field) return;
  const text = (q.editDraft || '').trim();

  if (text) {
    if (!q.sourceSnippet) { q.scanError = 'Scan a source snippet first.'; renderActiveQuestion(); return; }
    let valid;
    let why;
    if (field === 'answer' && q.answerScope === 'outside') {
      const page = q.answerPage != null ? q.answerPage : q.sourcePage;
      valid = textOnPage(q, page, text);
      why = `That text does not appear on page ${page}, where this answer is located.`;
    } else {
      valid = isContainedIn(text, q.sourceSnippet);
      why = `That text is not inside the source snippet, so it can't be saved as the ${field} snippet.`;
    }
    if (!valid) { q.scanError = why; renderActiveQuestion(); return; }
  }

  q.scanError = null;
  if (field === 'question') {
    q.questionSnippet = text;
    q.questionFound = !!text;
    q.questionOccurrence = 0;
  } else {
    q.answerSnippet = text;
    q.answerFound = !!text;
    q.answerOccurrence = 0;
    if (!text) { q.answerScope = 'inside'; q.answerPage = null; }
  }
  q.editingField = null;
  q.editDraft = '';
  reconcileFieldSync(q); // field sync: the committed snippet may change what the term / clamp question text derive to (before the re-render)
  recheckHighlightsForQuestion(qid, { force: true });
  renderQuestionNav();
  renderActiveQuestion();
}

// Entry point for edits that may affect a question's snippets. The local highlight recheck always runs (debounced so a run of
// edits is one pass and doesn't re-render the editor mid-typing); the AI resync is queued only when AUTO_SYNC_ENABLED is true.
const recheckTimers = new Map(); // qid -> setTimeout handle
function onSnippetRelevantEdit(qid) {
  if (recheckTimers.has(qid)) clearTimeout(recheckTimers.get(qid));
  recheckTimers.set(qid, setTimeout(() => {
    recheckTimers.delete(qid);
    recheckHighlightsForQuestion(qid);
  }, AUTO_SYNC_DEBOUNCE_MS));
  if (AUTO_SYNC_ENABLED) scheduleAutoSync(qid);
}

// Editing a question's text/term/page/choices schedules an auto recheck+resync, debounced per question so a run of edits triggers one pass, not one per field.
const autoSyncTimers = new Map(); // qid -> setTimeout handle
const AUTO_SYNC_DEBOUNCE_MS = 900;

function scheduleAutoSync(qid) {
  if (autoSyncTimers.has(qid)) clearTimeout(autoSyncTimers.get(qid));
  autoSyncTimers.set(qid, setTimeout(() => {
    autoSyncTimers.delete(qid);
    runAutoSync(qid);
  }, AUTO_SYNC_DEBOUNCE_MS));
}

// Re-syncs a question's snippets after an edit; guards against re-entrant calls for the same qid by queuing a single follow-up pass.
async function runAutoSync(qid) {
  const q = state.questions.find(x => x.id === qid);
  if (!q) return;

  console.log('[runAutoSync] DIAGNOSTIC entry', {
    qid,
    snippetBusy: q.snippetBusy,
    snippetSyncPending: q.snippetSyncPending,
    sourceSnippet: q.sourceSnippet,
    answerSnippet: q.answerSnippet,
  });

  // If a resync for this question is already running, don't recheck/resync against stale data — queue one follow-up pass and return; snippetSyncPending is a single flag, not a counter, so a burst of edits collapses into one follow-up.
  if (q.snippetBusy) {
    console.log('[runAutoSync] DIAGNOSTIC re-entrant call caught — queuing follow-up, not resyncing now', { qid });
    q.snippetSyncPending = true;
    renderActiveQuestion(); // let the footer reflect the queued follow-up right away
    return;
  }

  // Cheap, synchronous, no API call: relocates the existing snippet highlight but can't rewrite the snippet text itself — only handleResyncSnippets does that.
  recheckHighlightsForQuestion(qid);
  // Only spend an API call resyncing if the active provider is usable (a key for Gemini/OpenAI; an endpoint + model name for an OpenAI-compatible server).
  if (isProviderConfigured()) {
    await handleResyncSnippets(qid);
  } else {
    // Not configured: surface plainly that the snippet text wasn't resynced, only re-verified in place.
    q.snippetError = 'Snippet text wasn\u2019t resynced to your edit — set up an AI provider above (API key, or endpoint + model name) to enable AI resync (the highlight was only re-verified in place).';
    renderActiveQuestion();
  }

  // If another edit queued a follow-up pass while this one ran, run it now against the latest data.
  if (q.snippetSyncPending) {
    console.log('[runAutoSync] DIAGNOSTIC follow-up pass was queued during this run — running it now', { qid });
    q.snippetSyncPending = false;
    await runAutoSync(qid);
  } else {
    console.log('[runAutoSync] DIAGNOSTIC pass complete, no follow-up queued', { qid });
  }
}

// Creates a new blank question whose source snippet is the highlighted text; no AI call and no API key needed.
selectionGenerateBtn.addEventListener('click', () => {
  const sel = getPendingSelection();
  if (!sel) return;

  const q = newQuestion();
  q.sourcePage = sel.sourcePage;
  q.sourceId = sel.sourceId || state.activeSourceId;
  q.sourceSnippet = sel.text;
  q.sourceFound = true; // the source snippet IS the live selection — guaranteed present
  q.variants = [newVariant(selectionQuestionType.value)]; // dropdown only picks the type of the initial blank variant

  state.questions.push(q);
  sortQuestionsByPage();
  updateQuestionCount();
  renderTextVersion(); // redraws Pane 2 so the new source highlight shows (a dedicated source mark comes in the highlight-engine batch)

  window.getSelection().removeAllRanges();
  setActiveCard(q.id);
  hideSelectionToolbar();

  const num = state.questions.filter(x => x.sourceId === q.sourceId).findIndex(x => x.id === q.id) + 1;
  setSelectionGenStatus(`Created Q${String(num).padStart(2, '0')} from the selection — now scan its question and answer snippets.`, 'success');
  setTimeout(() => setSelectionGenStatus(''), 6000);
});

// Repairs common OCR/extraction artifacts (hyphenation across line breaks or spaces) before text is sent to the model or shown in an editor field.
function cleanExtractedText(text) {
  if (!text) return '';
  return text
    .replace(/(\w)-\s*\n\s*(\w)/g, '$1$2')
    .replace(/(\w)-\s+(\w)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export {
  resyncSnippetsForQuestion,
  handleResyncSnippets,
  handleScanField,
  handleScanAnswerOutside,
  startSnippetEdit,
  saveSnippetEdit,
  cancelSnippetEdit,
  onSnippetRelevantEdit,
  scheduleAutoSync,
  runAutoSync,
  cleanExtractedText,
};
