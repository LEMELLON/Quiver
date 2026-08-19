import { state, getPendingSelection, getLastDocSelection, setLastDocSelection } from './core-state.js';
import {
  apiKeyInput,
  modelSelect,
  docTextContainer,
  selectionGenerateBtn,
  selectionQuestionType,
} from './dom-refs.js';

import { fuzzyIncludes, unwrapMarksForQuestion, highlightSnippetInContainer, recheckHighlightsForQuestion } from './highlighting.js';
import { callGeminiApiWithRetry, callOpenAiApi } from './ai-api-calls.js';
import { safeParseAIJson } from './ai-prompt-builders.js';
import { parseClampVariantSet, handleApiError } from './variant-generation.js';
import { renderQuestionNav, renderActiveQuestion, setActiveCard } from './editor-render.js';
import { renderTextVersion } from './layout-formatting.js';
import { updateQuestionCount, sortQuestionsByPage } from './question-model.js';
import { hideSelectionToolbar } from './selection-toolbar.js';
import { setSelectionGenStatus } from './status-helpers.js';
import { applyPreferredQuestionType } from './batch-scan.js';

// System prompt for generating a definition-first question collection from a selected snippet.
const SNIPPET_SYSTEM_PROMPT = `You are a quiz-writing assistant embedded in a document-to-quiz tool that builds "question collections" — one target term/concept drawn from a snippet, starting with a fill-in-the-blank question. You will be given one short snippet of text extracted from a document, plus the page/slide number it came from.

Work definition-first, based strictly and only on the given snippet — never introduce facts that are not present in it:
1. Identify the single most important term or concept defined or explained in the snippet (the "target term").
2. CLAMP variant (sentence-continuation / fill-in-the-blank): write ONE full declarative sentence that states the snippet's definition of the term, with the target term itself as the sentence's leading subject — e.g. "Computer is an electronic machine that operates under the control of instructions...". Do NOT phrase this as a question and do NOT omit the term; the app strips the leading term itself to build the blank, so the term must be the very first words of the sentence. It also needs 4 answer choices (one of them the target term itself, i.e. what fills the blank) with exactly one correct answer.

Rules (follow strictly):
1. SELF-CONTAINED STEMS: every question/sentence must be understandable with no access to the source document.
2. CHOICE COUNTS: 4 choices by default (no fixed upper limit — a few more are fine if the concept genuinely calls for it, but never fewer than 2).
3. CLEAN TEXT: silently repair any OCR hyphenation or stray line breaks in the snippet; never reproduce them in a question, sentence, or choice.
4. ANSWER SNIPPET: also return "answerSnippet" — the exact substring, copied verbatim character-for-character from the given snippet (same spelling, spacing, and line breaks), that names/states the target term as it appears in the source. It must be a real substring of the snippet you were given, not a paraphrase. If no exact verbatim mention of the term exists in the snippet, return an empty string for it.
5. OUTPUT FORMAT: reply with ONLY a single JSON object, no markdown code fences and no commentary, in exactly this shape:

{
"targetTerm": "string — the key term or concept being defined",
"answerSnippet": "string — exact verbatim substring of the snippet naming the target term (or \"\" if none)",
"variants": {
  "clamp": {
    "sentence": "string — one full sentence, target term as its leading subject, e.g. 'TargetTerm is a ...'",
    "choices": ["string", "string", "string", "string"],
    "correctAnswerIndex": 0
  }
}
}

"correctAnswerIndex" is an integer indexing into that variant's own "choices" array.`;

// Generates a question collection from a selected snippet via AI; statusElement is an optional (msg, tone) reporter for quota/rate-limit errors.
async function generateQuestionFromSnippet(snippet, pageNum, statusElement) {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) throw new Error('Enter your Gemini or OpenAI API key in Pane 1 first.');
  if (snippet.length < 10) throw new Error('Select a longer snippet of text (more than 10 characters).');

  const provider = apiKey.startsWith('sk-') ? 'openai' : 'gemini';
  const model = modelSelect.value;
  const userPrompt = `Snippet (from page/slide ${pageNum}):\n"""\n${snippet}\n"""\n\nGenerate the definition-first question collection now, and return only the JSON object.`;

  let rawText;
  try {
    if (provider === 'gemini') {
      rawText = await callGeminiApiWithRetry(apiKey, model, SNIPPET_SYSTEM_PROMPT, userPrompt);
    } else {
      rawText = await callOpenAiApi(apiKey, model, SNIPPET_SYSTEM_PROMPT, userPrompt);
    }
  } catch (err) {
    if (handleApiError(err, statusElement)) {
      // Reuse handleApiError's friendly wording so the caller's message stays consistent.
      throw new Error('⚠ API Quota Exceeded or Rate Limited. You have run out of API usage or are making requests too quickly.');
    }
    throw err;
  }

  let parsed;
  try {
    parsed = safeParseAIJson(rawText);
  } catch (e) {
    parsed = null;
  }

  const variantSet = parseClampVariantSet(parsed);
  if (!variantSet) throw new Error('The AI response was not a usable question collection. Try selecting a different snippet.');

  // Kept verbatim (not cleaned) so it exact-matches the rendered text for highlighting, and validated as a real substring of the snippet.
  const answerSnippetRaw = parsed && typeof parsed.answerSnippet === 'string' ? parsed.answerSnippet : '';
  const answerSnippet = fuzzyIncludes(snippet, answerSnippetRaw) ? answerSnippetRaw : '';

  state.idCounter += 1;
  return {
    id: 'q_' + state.idCounter,
    sourcePage: pageNum,
    sourceId: state.activeSourceId,
    sourceSnippet: snippet,
    answerSnippet,
    targetTerm: parsed && typeof parsed.targetTerm === 'string' ? cleanExtractedText(parsed.targetTerm) : '',
    tier: 1,             // user-selected snippets are treated as top-tier by default
    verifyTier: 1,        // freshly located against the live selection — assumed exact
    sourceFound: true,     // the source snippet IS the live selection — guaranteed present
    answerFound: !!answerSnippet, // only true if the AI's answer passed the fuzzyIncludes check above
    definitionType: 'new',
    activeVariantIndex: 0,
    variants: variantSet,
    generatingType: null,
    variantGenError: null,
  };
}

// System prompt used by resyncSnippetsForQuestion (the "🔄 Resync snippets" button) to re-locate an edited question's source/answer passage on its page.
const RESYNC_SNIPPET_SYSTEM_PROMPT = `You are a quiz-writing assistant embedded in a document-to-quiz tool. You'll be given the full text of one page/slide, plus an existing quiz question (its target term and question text, and optionally its current choices/correct answer) that was written FROM that page. The person has just edited the question and/or its answer, so your job is to re-locate, inside the given page text, the passage that supports the question AS IT NOW READS.

Rules (follow strictly):
1. VERBATIM ONLY: "sourceSnippet" and "answerSnippet" must each be an exact, character-for-character substring of the given page text (same spelling, spacing, punctuation) — never paraphrase, summarize, or invent text that isn't literally there.
2. "sourceSnippet" is the broader passage that gives the question its context (can be a sentence, or a sentence plus the list/bullets it introduces, if the answer is an enumerated list).
3. "answerSnippet" is the narrower exact substring — within sourceSnippet if possible — that specifically states the correct answer/target term as edited. If the correct answer is itself an enumerated list, answerSnippet should cover that whole list.
4. UNIQUE CASE — flipped roles: if the question text now reads as "list the following: ___" and the answer is the definitional label/heading itself (rather than the enumeration), it's fine for answerSnippet to be the shorter heading-like phrase and sourceSnippet to be the longer enumeration — pick whichever assignment actually matches how the edited question/answer works, don't force sourceSnippet to always be the longer one.
5. If no passage in the given page text actually supports the edited question/answer, return empty strings for both rather than guessing.
6. OUTPUT FORMAT: reply with ONLY a single JSON object, no markdown code fences, no commentary:
{
"sourceSnippet": "string — exact verbatim substring of the page text, or \"\" if none fits",
"answerSnippet": "string — exact verbatim substring of the page text, or \"\" if none fits"
}`;

// Re-locates an edited question's source/answer snippets on its page via AI; returns {sourceSnippet, answerSnippet}, never mutates q.
async function resyncSnippetsForQuestion(q) {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) throw new Error('Enter your Gemini or OpenAI API key in Pane 1 first.');

  const page = state.pages.find(p => p.pageNumber === q.sourcePage);
  if (!page || !page.text || !page.text.trim()) {
    throw new Error(`No document text found on page ${q.sourcePage} — check the source page number.`);
  }
  const pageText = cleanExtractedText(page.text);

  const variant = q.variants[q.activeVariantIndex] || q.variants[0];
  const provider = apiKey.startsWith('sk-') ? 'openai' : 'gemini';
  const model = modelSelect.value;
  const choicesBlock = variant && Array.isArray(variant.choices) && variant.choices.some(c => c.trim())
    ? `\nCurrent choices: ${JSON.stringify(variant.choices)}, correct: ${JSON.stringify(variant.choices[variant.correctAnswerIndex] ?? '')}`
    : '';
  const userPrompt = `Page ${q.sourcePage} text:
"""
${pageText}
"""

Existing question (already edited by the person — re-sync to THIS, don't second-guess it):
Target term: "${q.targetTerm || '(not given)'}"
Question text: "${variant ? variant.questionText : ''}"${choicesBlock}

Return only the JSON object.`;

  let rawText;
  try {
    rawText = provider === 'gemini'
      ? await callGeminiApiWithRetry(apiKey, model, RESYNC_SNIPPET_SYSTEM_PROMPT, userPrompt)
      : await callOpenAiApi(apiKey, model, RESYNC_SNIPPET_SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    if (handleApiError(err, null)) {
      throw new Error('⚠ API Quota Exceeded or Rate Limited. You have run out of API usage or are making requests too quickly.');
    }
    throw err;
  }

  let parsed;
  try { parsed = safeParseAIJson(rawText); } catch (e) { parsed = null; }
  if (!parsed || typeof parsed !== 'object') throw new Error('The AI response was not usable. Try again.');

  const rawSource = typeof parsed.sourceSnippet === 'string' ? parsed.sourceSnippet : '';
  const rawAnswer = typeof parsed.answerSnippet === 'string' ? parsed.answerSnippet : '';
  const sourceSnippet = fuzzyIncludes(pageText, rawSource) ? rawSource : '';
  const answerSnippet = fuzzyIncludes(pageText, rawAnswer) ? rawAnswer : '';

  if (!sourceSnippet && !answerSnippet) {
    throw new Error('Could not find a matching passage on this page for the edited question/answer.');
  }
  return { sourceSnippet, answerSnippet };
}

// Runs resyncSnippetsForQuestion for one question and applies the result to state/DOM, preserving any slot the AI didn't find a fresh match for.
async function handleResyncSnippets(qid) {
  const q = state.questions.find(x => x.id === qid);
  if (!q || q.snippetBusy) return;

  q.snippetBusy = true;
  q.snippetError = null;
  renderActiveQuestion();

  try {
    const result = await resyncSnippetsForQuestion(q);
    console.log('[handleResyncSnippets] DIAGNOSTIC start', {
      qid: q.id,
      sourcePage: q.sourcePage,
      prior_sourceSnippet: q.sourceSnippet,
      prior_answerSnippet: q.answerSnippet,
      prior_sourceFound: q.sourceFound,
      prior_answerFound: q.answerFound,
      prior_verifyTier: q.verifyTier,
      result_sourceSnippet: result.sourceSnippet,
      result_answerSnippet: result.answerSnippet,
      result_sourceSnippet_truthy: !!result.sourceSnippet,
      result_answerSnippet_truthy: !!result.answerSnippet,
    });
    // Only overwrites a source/answer slot the AI round actually found a match for; an unmatched slot keeps its existing snippet, found flag, and highlight.
    const pageBody = docTextContainer.querySelector(`.doc-page[data-page="${q.sourcePage}"] .doc-page-body`);
    const preserved = [];

    if (result.sourceSnippet) {
      console.log('[handleResyncSnippets] DIAGNOSTIC source branch: UPDATING', { qid: q.id, newSnippet: result.sourceSnippet, pageBodyFound: !!pageBody });
      unwrapMarksForQuestion(docTextContainer, q.id, 'question');
      q.sourceSnippet = result.sourceSnippet;
      q.sourceFound = true;
      if (pageBody) highlightSnippetInContainer(pageBody, q.sourceSnippet, q.id, 'question', q.tier, 1);
      console.log('[handleResyncSnippets] DIAGNOSTIC source branch: after highlight call', {
        qid: q.id,
        marksNowInDoc: docTextContainer.querySelectorAll(`mark[data-qid~="${q.id}"][data-snippet-type="question"]`).length,
      });
    } else {
      console.log('[handleResyncSnippets] DIAGNOSTIC source branch: PRESERVING (empty result)', {
        qid: q.id,
        stillHasSnippet: !!q.sourceSnippet,
        marksStillInDoc: docTextContainer.querySelectorAll(`mark[data-qid~="${q.id}"][data-snippet-type="question"]`).length,
      });
      preserved.push('source');
    }

    if (result.answerSnippet) {
      console.log('[handleResyncSnippets] DIAGNOSTIC answer branch: UPDATING', { qid: q.id, newSnippet: result.answerSnippet, pageBodyFound: !!pageBody });
      unwrapMarksForQuestion(docTextContainer, q.id, 'answer');
      q.answerSnippet = result.answerSnippet;
      q.answerFound = true;
      if (pageBody) highlightSnippetInContainer(pageBody, q.answerSnippet, q.id, 'answer', q.tier, 1);
      console.log('[handleResyncSnippets] DIAGNOSTIC answer branch: after highlight call', {
        qid: q.id,
        marksNowInDoc: docTextContainer.querySelectorAll(`mark[data-qid~="${q.id}"][data-snippet-type="answer"]`).length,
      });
    } else {
      console.log('[handleResyncSnippets] DIAGNOSTIC answer branch: PRESERVING (empty result)', {
        qid: q.id,
        stillHasSnippet: !!q.answerSnippet,
        marksStillInDoc: docTextContainer.querySelectorAll(`mark[data-qid~="${q.id}"][data-snippet-type="answer"]`).length,
      });
      preserved.push('answer');
    }

    // Only advances verifyTier when both slots were refreshed this round; a preserved slot keeps its existing tier.
    if (!preserved.length) {
      q.verifyTier = 1; // freshly located against the live page text — assumed exact until the next recheck
    } else {
      q.snippetError = `${preserved[0]}: couldn\u2019t find a fresh match — kept the existing highlight`;
    }

    console.log('[handleResyncSnippets] DIAGNOSTIC end', {
      qid: q.id,
      preserved,
      final_sourceSnippet: q.sourceSnippet,
      final_answerSnippet: q.answerSnippet,
      final_sourceFound: q.sourceFound,
      final_answerFound: q.answerFound,
      final_verifyTier: q.verifyTier,
      final_snippetError: q.snippetError,
      totalMarksForQid_question: docTextContainer.querySelectorAll(`mark[data-qid~="${q.id}"][data-snippet-type="question"]`).length,
      totalMarksForQid_answer: docTextContainer.querySelectorAll(`mark[data-qid~="${q.id}"][data-snippet-type="answer"]`).length,
    });

    renderQuestionNav();
  } catch (err) {
    console.error('[handleResyncSnippets] DIAGNOSTIC caught error', err);
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

// Drops the most recently highlighted Pane 2 text into one field (source/answer) of a question and updates its source page, leaving the other field alone.
function handleScanField(qid, fieldType) {
  const q = state.questions.find(x => x.id === qid);
  if (!q) return;
  const field = fieldType === 'answer' ? 'answerSnippet' : 'sourceSnippet';
  const snippetType = fieldType === 'answer' ? 'answer' : 'question';

  const sel = getLastDocSelection();
  if (!sel || !sel.text) {
    q.scanError = `Highlight the ${snippetType === 'answer' ? 'answer' : 'question/context'} passage in the document text (Pane 2) first, then click "Scan ${snippetType}" again.`;
    renderActiveQuestion();
    setTimeout(() => {
      if (q.scanError) {
        q.scanError = null;
        if (state.activeCardId === qid) renderActiveQuestion();
      }
    }, 5000);
    return;
  }

  q.scanError = null;
  unwrapMarksForQuestion(docTextContainer, q.id, snippetType);
  q[field] = sel.text;
  if (snippetType === 'question') q.sourceFound = true; else q.answerFound = true;
  q.sourcePage = sel.sourcePage; // the highlighted passage is now the source of truth for where this question lives
  q.sourceId = state.activeSourceId;

  // Uses highlightSnippetInContainer's text-search path (rather than wrapping the live Range directly) to avoid corrupting multi-block selections.
  const pageBody = docTextContainer.querySelector(`.doc-page[data-page="${q.sourcePage}"] .doc-page-body`);
  if (pageBody) highlightSnippetInContainer(pageBody, sel.text, q.id, snippetType, q.tier, 1);

  window.getSelection().removeAllRanges();
  setLastDocSelection(null);
  hideSelectionToolbar();
  renderQuestionNav();
  renderActiveQuestion();
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
  // Only spend an API call resyncing if a key is configured.
  if (apiKeyInput.value.trim()) {
    await handleResyncSnippets(qid);
  } else {
    // No key: surface plainly that the snippet text wasn't resynced, only re-verified in place.
    q.snippetError = 'Snippet text wasn\u2019t resynced to your edit — add an API key above to enable AI resync (the highlight was only re-verified in place).';
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

selectionGenerateBtn.addEventListener('click', async () => {
  if (!getPendingSelection()) return;
  const { text, sourcePage } = getPendingSelection();

  selectionGenerateBtn.disabled = true;
  selectionGenerateBtn.textContent = 'Generating…';
  setSelectionGenStatus('Generating a question from the selected text…');

  try {
    const q = await generateQuestionFromSnippet(text, sourcePage, setSelectionGenStatus);
    await applyPreferredQuestionType([q], selectionQuestionType.value);
    state.questions.push(q);
    sortQuestionsByPage();

    // Uses highlightSnippetInContainer's text-search path (rather than wrapping the live Range directly) to avoid corrupting multi-block selections.
    const pageBody = docTextContainer.querySelector(`.doc-page[data-page="${q.sourcePage}"] .doc-page-body`);
    if (pageBody) {
      highlightSnippetInContainer(pageBody, q.sourceSnippet, q.id, 'question', q.tier, 1);
      if (q.answerSnippet) highlightSnippetInContainer(pageBody, q.answerSnippet, q.id, 'answer', q.tier, 1);
    } else {
      renderTextVersion(); // fall back to a full re-render + text-search highlight pass
    }

    window.getSelection().removeAllRanges();
    updateQuestionCount();
    setActiveCard(q.id);
    setSelectionGenStatus(`Added Q${String(state.questions.length).padStart(2, '0')} from the selection.`, 'success');
    setTimeout(() => setSelectionGenStatus(''), 3000);
  } catch (err) {
    console.error(err);
    setSelectionGenStatus(err.message || 'Failed to generate a question from that selection.', 'error');
  } finally {
    selectionGenerateBtn.disabled = false;
    selectionGenerateBtn.textContent = '⚡ Generate Question from Selection';
    hideSelectionToolbar();
  }
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
  generateQuestionFromSnippet,
  resyncSnippetsForQuestion,
  handleResyncSnippets,
  handleScanField,
  scheduleAutoSync,
  runAutoSync,
  cleanExtractedText,
};
