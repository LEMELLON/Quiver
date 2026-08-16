// snippet-question-generation.js
// Extracted verbatim from online-quiz-maker.html. This module's function
// list per MODULARIZATION_SCHEMA.txt (module [11]) is:
//   generateQuestionFromSnippet, resyncSnippetsForQuestion,
//   handleResyncSnippets, handleScanField, scheduleAutoSync, runAutoSync,
//   cleanExtractedText
// Function/const bodies are UNCHANGED from source — only import/export
// wrapper lines were added. See the NOTE blocks below for the spots
// where ES-module mechanics required small, clearly-flagged structural
// additions (not logic changes) to keep shared state working across
// module boundaries.
//
// SOURCE LINE RANGES (in original file order):
//   3189-3214  SNIPPET_SYSTEM_PROMPT        (pulled forward — see NOTE)
//   3579-3641  generateQuestionFromSnippet
//   3651-3663  RESYNC_SNIPPET_SYSTEM_PROMPT
//   3670-3722  resyncSnippetsForQuestion
//   3724-3765  handleResyncSnippets
//   3790-3837  handleScanField
//   3846-3847  autoSyncTimers / AUTO_SYNC_DEBOUNCE_MS
//   3849-3855  scheduleAutoSync
//   3857-3878  runAutoSync
//   3881-3926  selectionGenerateBtn 'click' listener (moved with handler)
//   3935-3942  cleanExtractedText
//
// NOTE (structural, not a logic change): SNIPPET_SYSTEM_PROMPT (source
// lines 3189-3214) sits physically inside variant-generation.js's line
// range (3097-3570) in the original file, but is used ONLY by
// generateQuestionFromSnippet below — so per the "constant moves with
// its sole usage site, not its physical position" precedent (see
// variant-generation.js's own header note, and DUPLICATE_SNIPPET_MIN_LEN
// in question-model.js before it), it's extracted here instead, placed
// immediately before the function that uses it.
//
// NOTE (structural, not a logic change): `lastDocSelection` (source line
// 648) is a module-level `let` that this module both reads
// (handleScanField) and reassigns (`lastDocSelection = null;` in
// handleScanField). Same ES-module read-only-binding issue already
// flagged for `duplicateMap`/`pendingSelection` elsewhere — it now lives
// in core-state.js with a getter/setter pair. The two textual changes in
// this file are mechanical: `const sel = lastDocSelection;` ->
// `const sel = getLastDocSelection();` and `lastDocSelection = null;` ->
// `setLastDocSelection(null);`.
//
// NOTE (structural, not a logic change): `pendingSelection` (source line
// 647) is read (never reassigned) by the selectionGenerateBtn listener
// below. Same getter/setter already established in selection-toolbar.js;
// this file's only change is `if (!pendingSelection) return;` ->
// `if (!getPendingSelection()) return;` and destructuring from
// `getPendingSelection()` instead of the bare identifier.
//
// FLAGGED (event wiring, moved with handler): the selectionGenerateBtn
// 'click' listener (source lines 3881-3926) sits between
// RESYNC_SNIPPET_SYSTEM_PROMPT's neighborhood and the AI bulk-generation
// banner comment, but its handler body's primary job is calling
// generateQuestionFromSnippet (defined in this module) and assembling
// the resulting question — so per the "move with handler" strategy used
// throughout this modularization (see e.g. formatLayoutBtn in
// layout-formatting.js, or the mouseup/scroll/mousedown listeners in
// selection-toolbar.js), it's included here rather than left for a
// wire-events orchestrator.

// --- Shared dependencies ---
import { state, getPendingSelection, getLastDocSelection, setLastDocSelection } from './core-state.js';
import {
  apiKeyInput,
  modelSelect,
  docTextContainer,
  selectionGenerateBtn,
  selectionQuestionType,
} from './dom-refs.js';

// Functions from other modules that these functions call:
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

// ---------------------------------------------------------------------
// Verbatim from source, lines 3189-3214 (pulled forward — see NOTE above)
// ---------------------------------------------------------------------
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

// `statusElement` is optional — pass a (msg, tone) reporter such as
// setSelectionGenStatus so a quota/rate-limit failure gets its own
// friendly message instead of whatever raw error text the API/SDK
// happened to throw. Note that Gemini calls already retry internally
// (see callGeminiApiWithRetry) before an error ever reaches here, so a
// Gemini 429 surfacing at this point means retries were exhausted, not
// that this is the first attempt.
// ---------------------------------------------------------------------
// Verbatim from source, lines 3579-3641
// ---------------------------------------------------------------------
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
      // Replace the raw SDK/HTTP error with the same friendly wording
      // handleApiError just displayed, so whatever the caller does with
      // err.message next (e.g. the click handler's own status update)
      // stays consistent instead of flashing the technical message.
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

  // answerSnippet is kept verbatim (not run through cleanExtractedText)
  // since it must match, character-for-character, the exact text that's
  // already rendered in Pane 2 in order for highlightSnippetInContainer
  // to find it. It's also validated as a real substring of the snippet
  // the user selected — an AI-invented "verbatim" answer wouldn't be.
  const answerSnippetRaw = parsed && typeof parsed.answerSnippet === 'string' ? parsed.answerSnippet : '';
  const answerSnippet = fuzzyIncludes(snippet, answerSnippetRaw) ? answerSnippetRaw : '';

  state.idCounter += 1;
  return {
    id: 'q_' + state.idCounter,
    sourcePage: pageNum,
    // UPDATE 2A: see the matching note in question-model.js's
    // newQuestion(). Pane 2 only ever renders the active source's pages
    // in 2A (2B is what lets it show more than one source at once — see
    // handoff doc), so "the selection this snippet came from" and "the
    // active source" are guaranteed to be the same thing here.
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

// ---------- On-demand snippet resync (single question) ----------
// Used by the "🔄 Resync snippets (AI)" button. Unlike
// generateQuestionFromSnippet (which mints a whole new question from a
// hand-selected passage), this takes an EXISTING question whose
// question/answer text the person just edited and re-searches that
// question's own source page for the passage that now matches —
// useful when an edit means the old sourceSnippet/answerSnippet no
// longer point at the right place (or don't exist yet at all).
// ---------------------------------------------------------------------
// Verbatim from source, lines 3651-3663
// ---------------------------------------------------------------------
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

// Returns { sourceSnippet, answerSnippet } (each already verified as a
// real verbatim substring of the page text via fuzzyIncludes — an
// entry that fails verification is dropped to "" rather than trusted
// blindly, same policy as generateQuestionFromSnippet's answerSnippet
// handling). Never mutates `q`; the caller applies the result.
// ---------------------------------------------------------------------
// Verbatim from source, lines 3670-3722
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Verbatim from source, lines 3724-3765
// ---------------------------------------------------------------------
async function handleResyncSnippets(qid) {
  const q = state.questions.find(x => x.id === qid);
  if (!q || q.snippetBusy) return;

  q.snippetBusy = true;
  q.snippetError = null;
  renderActiveQuestion();

  try {
    const result = await resyncSnippetsForQuestion(q);
    // DIAGNOSTIC (temporary — remove once the still-open bug is
    // root-caused): dump exactly what came back and what q's prior
    // values were, before any branch below mutates either.
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
    // --- Restored per-slot preservation logic. Traces to:
    //   RESYNC_SNIPPET_OVERWRITE_CLEARS_HIGHLIGHT_FIX_PROMPT.md (original fix)
    //   HANDLERESYNC_REGRESSION_FIX_PROMPT.md (this regression's correction)
    // resyncSnippetsForQuestion() only throws when BOTH fields come back
    // empty, so a result with exactly one field empty reaches here. Each
    // slot (source/answer) is only unwrapped and overwritten when this
    // round's result actually found something for it; an empty slot
    // leaves the existing snippet, its found flag, and its DOM mark
    // untouched instead of being wiped.
    // HIGHLIGHT_DUPLICATE_SHARED_MARK_FIX_PROMPT.md: the diagnostic
    // `mark[data-qid="${q.id}"]` queries below were switched to `~=`
    // (word-match) — a mark's data-qid can now hold more than one id (a
    // shared duplicate-pair mark, see highlighting.js), so a plain `=`
    // lookup would under-count marks that legitimately belong to this
    // question but happen to be shared with a duplicate. Diagnostic-only,
    // no behavior change.
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

    // Only advance verifyTier when both slots were actually refreshed
    // this round — a preserved slot keeps whichever tier the question
    // already had.
    if (!preserved.length) {
      q.verifyTier = 1; // freshly located against the live page text — assumed exact until the next recheck
    } else {
      q.snippetError = `${preserved[0]}: couldn\u2019t find a fresh match — kept the existing highlight`;
    }

    // DIAGNOSTIC (temporary): final state of q after this pass, and
    // total marks for this qid left in the document — compare this to
    // the DIAGNOSTIC start dump above to see exactly what changed.
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

// =====================================================================
// Manual single-field scan — "🔎 Scan question" / "🔎 Scan answer"
// buttons in the editor. This is no longer AI-driven: it simply takes
// whatever text the user most recently highlighted in the document text
// (Pane 2) — captured into `lastDocSelection` by handleTextSelection —
// and drops it straight into this one field, leaving the other slot
// completely alone.
//
// This matters most for classification-style ("Category Selection")
// questions, where one shared question stem covers several correct
// answers that each live in a different spot in the source text — e.g.
// a "Threats to Databases" stem whose answer choices (loss of
// integrity / availability / confidentiality) are each defined in
// their own paragraph. Highlighting the question stem once and then
// each answer separately lets the person build up the full picture
// piece by piece, without relying on the AI to guess which one they
// meant.
//
// Workflow: select/highlight the passage in Pane 2, then click
// "🔎 Scan question" or "🔎 Scan answer" on the question card — the
// highlighted text becomes that field's snippet, and the question's
// source page is updated to match wherever the highlight was made.
// =====================================================================
// ---------------------------------------------------------------------
// Verbatim from source, lines 3790-3837, except the two mechanical
// `const sel = lastDocSelection;` -> `const sel = getLastDocSelection();`
// and `lastDocSelection = null;` -> `setLastDocSelection(null);`
// substitutions (see NOTE at top of file).
// ---------------------------------------------------------------------
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
  // UPDATE 2A: keep q.sourceId in step with q.sourcePage above. Same
  // "Pane 2 only ever shows the active source in 2A" reasoning as
  // generateQuestionFromSnippet — sel itself doesn't carry a sourceId
  // yet (that's 2B's job, once Pane 2 can render more than one source's
  // pages and selection-toolbar.js starts capturing data-source-id).
  q.sourceId = state.activeSourceId;

  // PANE2_HIGHLIGHT_CORRUPTION_CONTINUATION_PROMPT.md root-cause fix:
  // this used to hand-wrap the live selection Range directly
  // (sel.range.extractContents() + sel.range.insertNode()), bypassing
  // both of highlightSnippetInContainer's safety mechanisms — block-
  // boundary segmentation and mark-widening. When the live selection
  // spanned multiple <li>/<p> blocks, or its boundary landed imprecisely
  // relative to an existing <mark>, extractContents()'s partial-
  // containment-clone behavior corrupted the document (emptied <li>
  // shells, words split mid-word). Route through the same hardened,
  // text-search-based path every other highlight call site in the app
  // already uses instead: it re-locates this exact passage (sel.text,
  // which was captured from this same live selection) and applies both
  // protections for free. This drops the old raw-Range fast path
  // entirely rather than keeping it as a "try" — it offered no benefit
  // over the text-search path once this call is on the safe path,
  // fuzzyIncludes was already used to verify sel.text against the
  // document elsewhere, and highlightSnippetInContainer already no-ops
  // safely if the text genuinely can't be found.
  const pageBody = docTextContainer.querySelector(`.doc-page[data-page="${q.sourcePage}"] .doc-page-body`);
  if (pageBody) highlightSnippetInContainer(pageBody, sel.text, q.id, snippetType, q.tier, 1);

  window.getSelection().removeAllRanges();
  setLastDocSelection(null);
  hideSelectionToolbar();
  renderQuestionNav();
  renderActiveQuestion();
}


// ---------- Auto recheck + resync after an edit ----------
// Rather than requiring a manual click, editing a question's text,
// target term, source page, or choices/correct-answer now schedules
// this automatically (see the 'change' listener above). Debounced per
// question so a quick run of edits (e.g. typing across all 4 choice
// fields) only triggers one pass, not one per field.
// ---------------------------------------------------------------------
// Verbatim from source, lines 3846-3847
// ---------------------------------------------------------------------
const autoSyncTimers = new Map(); // qid -> setTimeout handle
const AUTO_SYNC_DEBOUNCE_MS = 900;

// ---------------------------------------------------------------------
// Verbatim from source, lines 3849-3855
// ---------------------------------------------------------------------
function scheduleAutoSync(qid) {
  if (autoSyncTimers.has(qid)) clearTimeout(autoSyncTimers.get(qid));
  autoSyncTimers.set(qid, setTimeout(() => {
    autoSyncTimers.delete(qid);
    runAutoSync(qid);
  }, AUTO_SYNC_DEBOUNCE_MS));
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 3857-3878, plus the
// AUTOSYNC_REENTRANCY_RACE_FIX_PROMPT.md re-entrancy fix (the
// q.snippetBusy check at the top and the trailing-pending-pass check
// at the bottom — see comments inline below).
// ---------------------------------------------------------------------
async function runAutoSync(qid) {
  const q = state.questions.find(x => x.id === qid);
  if (!q) return;

  // DIAGNOSTIC (temporary): every entry into runAutoSync, and whether
  // a resync for this qid is already in flight at that moment.
  console.log('[runAutoSync] DIAGNOSTIC entry', {
    qid,
    snippetBusy: q.snippetBusy,
    snippetSyncPending: q.snippetSyncPending,
    sourceSnippet: q.sourceSnippet,
    answerSnippet: q.answerSnippet,
  });

  // AUTOSYNC_REENTRANCY_RACE_FIX_PROMPT.md root-cause fix: previously
  // this ran recheckHighlightsForQuestion unconditionally (against
  // whatever sourceSnippet/answerSnippet happened to be current —
  // stale, if an earlier resync for this same qid was still in
  // flight), then called handleResyncSnippets, which silently no-oped
  // on its own `q.snippetBusy` guard with no retry and no error — so a
  // second edit landing while the first edit's AI resync was still in
  // flight got dropped entirely. Check the same guard here, first,
  // before doing any work: if a resync for this question is already
  // running, don't recheck/resync against stale data now — just record
  // that another pass is wanted once the in-flight one finishes, and
  // return. `snippetSyncPending` is a single trailing flag (not a
  // queue/counter) by design: a burst of edits during one in-flight
  // resync should collapse into exactly one follow-up pass, not one
  // per edit.
  if (q.snippetBusy) {
    console.log('[runAutoSync] DIAGNOSTIC re-entrant call caught — queuing follow-up, not resyncing now', { qid });
    q.snippetSyncPending = true;
    renderActiveQuestion(); // let the footer reflect the queued follow-up right away
    return;
  }

  // Cheap, synchronous, no API call — always safe to run first. Note
  // this only *relocates* the existing snippet text in the document;
  // it can't rewrite the snippet itself to match a just-edited
  // question/answer — only handleResyncSnippets (below) does that.
  recheckHighlightsForQuestion(qid);
  // Only spend an API call resyncing if there's a key configured and a
  // question to base it on; recheckHighlightsForQuestion above already
  // reported status for the case where there's nothing to check yet.
  if (apiKeyInput.value.trim()) {
    await handleResyncSnippets(qid);
  } else {
    // No key — the snippet text itself was NOT resynced to the edit,
    // only re-verified in place. Surface that plainly instead of
    // leaving the "✓ Snippets auto-sync after each edit" footer
    // implying the edit was fully picked up.
    q.snippetError = 'Snippet text wasn\u2019t resynced to your edit — add an API key above to enable AI resync (the highlight was only re-verified in place).';
    renderActiveQuestion();
  }

  // AUTOSYNC_REENTRANCY_RACE_FIX_PROMPT.md: if another edit came in
  // while the pass above was running (caught by the snippetBusy check
  // at the top, on a re-entrant call for this same qid), run exactly
  // one more full pass now — against whatever sourceSnippet/
  // answerSnippet/target-term text is current *now* — instead of
  // letting that edit's resync evaporate.
  if (q.snippetSyncPending) {
    console.log('[runAutoSync] DIAGNOSTIC follow-up pass was queued during this run — running it now', { qid });
    q.snippetSyncPending = false;
    await runAutoSync(qid);
  } else {
    console.log('[runAutoSync] DIAGNOSTIC pass complete, no follow-up queued', { qid });
  }
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 3881-3926 (event wiring — moved with
// handler per the schema's strategy, see FLAGGED note at top of file),
// except the two mechanical `pendingSelection` -> `getPendingSelection()`
// substitutions (see NOTE at top of file).
// ---------------------------------------------------------------------
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

    // PANE2_HIGHLIGHT_CORRUPTION_CONTINUATION_PROMPT.md root-cause fix:
    // this used to hand-wrap the live pending-selection Range directly
    // (range.extractContents() + range.insertNode()), bypassing both of
    // highlightSnippetInContainer's safety mechanisms — block-boundary
    // segmentation and mark-widening. A selection spanning multiple
    // <li>/<p> blocks, or landing imprecisely relative to an existing
    // <mark>, corrupted the document via extractContents()'s partial-
    // containment-clone behavior (emptied <li> shells, words split
    // mid-word). Route through the same hardened, text-search-based
    // path every other highlight call site in the app already uses
    // instead — q.sourceSnippet is exactly the text of this same live
    // selection (generateQuestionFromSnippet stores its `snippet`
    // argument verbatim as sourceSnippet), so this re-locates the
    // identical passage with both protections applied, then nests the
    // answer mark inside it exactly as before.
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

// =====================================================================
// AI-powered bulk quiz generation engine (Gemini / OpenAI)
// =====================================================================

// Repairs common OCR/extraction artifacts (line-break or space hyphenation,
// e.g. "signa- tures" -> "signatures") before text is sent to the model
// or shown in an editor field.
// ---------------------------------------------------------------------
// Verbatim from source, lines 3935-3942
// ---------------------------------------------------------------------
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