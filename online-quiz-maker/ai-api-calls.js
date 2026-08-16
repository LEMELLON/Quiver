// ai-api-calls.js
// Extracted verbatim from online-quiz-maker.html (module [13] per
// MODULARIZATION_SCHEMA.txt): sleep, isGeminiRateLimitError,
// parseSuggestedRetryDelayMs, callGeminiApiWithRetry, callOpenAiApi,
// parseAiQuestions, callAiSystemPrompt, runTierPass,
// generateQuestionsWithAI. Function/const bodies are UNCHANGED from
// source — only import/export wrapper lines were added.
//
// SOURCE LINE RANGES (in original file order):
//   4138       sleep
//   4140-4145  isGeminiRateLimitError
//   4152-4159  parseSuggestedRetryDelayMs
//   4168-4192  callGeminiApiWithRetry
//   4197-4231  callOpenAiApi
//   4242-4327  parseAiQuestions
//   4332-4337  callAiSystemPrompt
//   4349-4368  runTierPass
//   4384-4429  generateQuestionsWithAI
//
// Uses GeminiClassifier directly, same as the source did (loaded via a
// separate <script src="gemini-classifier.js"> tag already in the HTML
// — no import needed, it attaches to window).
//
// FLAGGED (not moved here, not part of this module): the pdfFileInput
// 'change' event listener (source lines 4431 onward) sits immediately
// after generateQuestionsWithAI and calls it, but it isn't listed under
// this module's function list in MODULARIZATION_SCHEMA.txt — it also
// calls extractPptxPages/extractPdfPages (doc-extraction.js) as its
// primary job (parsing the uploaded file), with generateQuestionsWithAI
// only invoked further down its body. Per the schema's own instruction
// ("if something is ambiguous, leave it in place / flag it — do not
// guess-and-rewrite"), it's left out of this extraction rather than
// guessed into a module. Most likely destination: doc-extraction.js
// (alongside the functions it primarily wires up) or the main
// orchestrator, on a later pass.
//
// GEMINI_MODEL_FIX_AND_PPTX_DIAGNOSTICS_PROMPT.md Issue 1b — model-
// not-found fast-fail (see the new isGeminiModelNotFoundError() below,
// and its use in callGeminiApiWithRetry() and runTierPass()): a Gemini
// 404 ("this model is no longer available") is a PERMANENT failure —
// unlike a 429, retrying it can never succeed, so it's now detected
// distinctly from isGeminiRateLimitError() and never retried, and
// surfaces one clear setParseStatus() message instead of failing
// silently. This module's own call paths (runTierPass ->
// generateQuestionsWithAI) already stopped iterating on ANY thrown
// error before this fix (neither function swallows an API-call
// failure), so no control-flow restructuring was needed there — only
// clearer detection and a better message.
//
// NOT FIXED HERE — layout-formatting.js (not included in this upload,
// so it can't be edited as part of this pass): the bug report's actual
// per-page silent-failure symptom ("layout-formatting.js:209 Layout
// formatting failed for page 1", repeated once per page against the
// same doomed model) lives in that file's formatAllPagesLayout() loop,
// which isn't visible here. `isGeminiModelNotFoundError` is exported
// below specifically so that file can import and use it. Whoever owns
// that file should apply this shape inside its per-page catch block:
//
//   import { isGeminiModelNotFoundError } from './ai-api-calls.js';
//   ...
//   for (const page of pages) {
//     try {
//       await formatPageLayout(page, ...); // or whatever it currently calls
//     } catch (err) {
//       console.error(`Layout formatting failed for page ${page.pageNumber}`, err);
//       if (isGeminiModelNotFoundError(err) || err.isModelNotFound) {
//         setParseStatus(`Layout formatting stopped: the selected model is no longer available. Please choose a different model from the dropdown above.`);
//         break; // don't burn through the remaining pages on a model that can never succeed
//       }
//     }
//   }
//
// (callGeminiApiWithRetry already tags the thrown error with
// `err.isModelNotFound = true` in addition to being detectable via
// isGeminiModelNotFoundError(err) — either works as the check above.)

// --- Shared dependencies ---
import { state } from './core-state.js';
import { apiKeyInput, modelSelect } from './dom-refs.js';
import { setParseStatus } from './status-helpers.js';
import { normalizeTermKey } from './text-normalize.js';
import { cleanExtractedText } from './snippet-question-generation.js';
import { fuzzyIncludes } from './highlighting.js';
import { parseClampVariantSet } from './variant-generation.js';
import {
  TIER_SYSTEM_PROMPTS,
  formatTierSystemPrompt,
  buildPagesPrompt,
  mergeTerms,
  collectTargetTerms,
  safeParseAIJson,
} from './ai-prompt-builders.js';

// =====================================================================
// Gemini rate-limit handling (429 / RESOURCE_EXHAUSTED).
//
// NOTE ON SCOPE: the raw fetch() to Gemini's REST API lives inside
// gemini-classifier.js (loaded via <script src="gemini-classifier.js">
// in <head>), which is a separate file not included in this upload —
// this file only ever sees GeminiClassifier.generateContent()'s
// resolved value or thrown Error. That means this wrapper can't
// inspect a raw Response/status code directly; it detects a 429 by
// pattern-matching the thrown Error's `.message` (and `.status`/`.code`
// if GeminiClassifier happens to set them), the same way callOpenAiApi
// above already surfaces OpenAI errors as Error.message text. If
// gemini-classifier.js's error shape differs from this, adjust
// isGeminiRateLimitError()/parseSuggestedRetryDelayMs() to match it —
// everything else in this block is provider-agnostic.
// =====================================================================

// ---------------------------------------------------------------------
// Verbatim from source, line 4138
// ---------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------
// Verbatim from source, lines 4140-4145
// ---------------------------------------------------------------------
function isGeminiRateLimitError(err) {
  if (!err) return false;
  if (err.status === 429 || err.code === 429) return true;
  const msg = String(err.message || err);
  return /\b429\b/.test(msg) || /RESOURCE_EXHAUSTED/i.test(msg) || /quota exceeded/i.test(msg);
}

// GEMINI_MODEL_FIX_AND_PPTX_DIAGNOSTICS_PROMPT.md Issue 1b — detects a
// Gemini "model no longer exists" failure (HTTP 404 / NOT_FOUND),
// distinct from isGeminiRateLimitError's 429 case just above. This is a
// PERMANENT failure: the exact same request will 404 again no matter
// how long we wait or how many times we retry, because the model ID
// itself has been retired — unlike a 429, which is transient and worth
// waiting out. Same message-pattern-matching approach as
// isGeminiRateLimitError, for the same reason (see NOTE ON SCOPE above
// — this file only ever sees GeminiClassifier.generateContent()'s
// thrown Error, not a raw Response).
function isGeminiModelNotFoundError(err) {
  if (!err) return false;
  if (err.status === 404 || err.code === 404) return true;
  const msg = String(err.message || err);
  if (!/\b404\b/.test(msg) && !/\bNOT_FOUND\b/i.test(msg)) return false;
  return /no longer available|is not found|was not found|not supported for/i.test(msg);
}

// Pulls a model-suggested wait time out of a Gemini error message —
// e.g. "...Please retry in 19.97s." or a serialized
// "retryDelay":"19s" field — so a server-specified cooldown is honored
// instead of guessing. Returns milliseconds, or null if no explicit
// delay was present (caller then falls back to exponential backoff).
// ---------------------------------------------------------------------
// Verbatim from source, lines 4152-4159
// ---------------------------------------------------------------------
function parseSuggestedRetryDelayMs(err) {
  const msg = String((err && err.message) || err || '');
  let m = msg.match(/retry in\s+([\d.]+)\s*s/i);
  if (m) return Math.ceil(parseFloat(m[1]) * 1000);
  m = msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
  if (m) return Math.ceil(parseFloat(m[1]) * 1000);
  return null;
}

// Wraps a single Gemini call (via GeminiClassifier.generateContent) with
// retry + exponential backoff. On a 429 / RESOURCE_EXHAUSTED error it
// waits (using the model's suggested delay when the error message
// provides one, otherwise initialDelayMs * 2^attempt + jitter) and
// retries, up to maxRetries times, before letting the error surface to
// the caller. Any non-rate-limit error (bad key, network failure, etc.)
// propagates immediately without retrying.
// ---------------------------------------------------------------------
// Verbatim from source, lines 4168-4192
// ---------------------------------------------------------------------
async function callGeminiApiWithRetry(apiKey, model, systemPrompt, userPrompt, maxRetries = 4, initialDelayMs = 4000) {
  if (typeof GeminiClassifier === 'undefined') {
    throw new Error('Gemini classifier module failed to load — check your network connection.');
  }
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      GeminiClassifier.setKey(apiKey);
      return await GeminiClassifier.generateContent(model, systemPrompt, userPrompt);
    } catch (err) {
      lastErr = err;

      if (isGeminiModelNotFoundError(err)) {
        // Permanent failure (Issue 1b) — this exact model ID will never
        // succeed no matter how many attempts remain, so stop
        // immediately instead of burning through maxRetries, and tag
        // the error so callers that don't import
        // isGeminiModelNotFoundError themselves (e.g. layout-
        // formatting.js — see the file-header note above) can still
        // detect it via a plain `err.isModelNotFound` check.
        err.isModelNotFound = true;
        console.warn(`Gemini model "${model}" is no longer available — not retrying.`, err);
        setParseStatus(`The selected model ("${model}") is no longer available. Please choose a different model from the dropdown above.`);
        throw err;
      }

      if (!isGeminiRateLimitError(err) || attempt === maxRetries) throw err;

      const suggestedDelay = parseSuggestedRetryDelayMs(err);
      const delay = suggestedDelay != null
        ? suggestedDelay
        : initialDelayMs * Math.pow(2, attempt) + Math.random() * 1000;

      console.warn(`Gemini 429 rate limit — retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms`, err);
      setParseStatus(`Gemini rate limit hit — retrying in ${Math.ceil(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})…`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// `useJsonMode` defaults to true (existing question-generation callers
// rely on OpenAI's JSON mode). Pass false for callers that want a raw
// text/HTML fragment back instead of a forced { ... } JSON object.
// ---------------------------------------------------------------------
// Verbatim from source, lines 4197-4231
// ---------------------------------------------------------------------
async function callOpenAiApi(apiKey, model, systemPrompt, userPrompt, useJsonMode = true) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.4,
  };
  if (useJsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch (e) { /* ignore */ }
    const apiErr = new Error(`OpenAI API error (${res.status})${detail ? ': ' + detail : '. Check your API key and model.'}`);
    // Attach the HTTP status so handleApiError's `err.status === 429`
    // check reliably catches an OpenAI rate-limit/quota response even
    // when OpenAI's own error text doesn't happen to say "quota" or
    // "rate limit" verbatim.
    apiErr.status = res.status;
    throw apiErr;
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text.trim()) throw new Error('OpenAI returned an empty response.');
  return text;
}

// `tier` (1|2|3) tags every produced question with its scan pass.
// `registry` is a Map shared across all 3 passes, keyed by
// normalizeTermKey(targetTerm) (punctuation/case-insensitive — see its
// definition above), that records the canonical { targetTerm, answerSnippet }
// for every "new" definition seen so far — this is what lets a Tier 2
// "extension" item resolve back to its parent's exact targetTerm and
// answerSnippet (rather than trusting whatever the AI repeated) and
// safely downgrades to "new" if it names a parent that was never
// actually registered (a hallucinated or not-yet-seen reference).
// ---------------------------------------------------------------------
// Verbatim from source, lines 4242-4327
// ---------------------------------------------------------------------
function parseAiQuestions(rawText, fallbackPage, tier, registry) {
  const parsed = safeParseAIJson(rawText);
  if (!parsed) throw new Error('The AI response was not valid JSON.');

  const list = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed.collections) ? parsed.collections
    : Array.isArray(parsed.questions) ? parsed.questions
    : null;
  if (!list) throw new Error('The AI response did not include a "collections" array.');

  const cleaned = [];
  for (const item of list) {
    if (!item) continue;
    const variantSet = parseClampVariantSet(item);
    if (!variantSet) continue;

    const sourcePage = Number.isFinite(Number(item.sourcePage)) ? Number(item.sourcePage) : fallbackPage;
    // Snippets are kept verbatim (not cleaned) so they can still be
    // found, character-for-character, in Pane 2's rendered page text.
    // Validate each against that page's actual extracted text — an AI
    // response that "hallucinated" a non-verbatim snippet is dropped
    // rather than trusted, since highlightSnippetInContainer would just
    // silently fail to find it anyway.
    // Validate against cleanExtractedText(pageText) — the same cleaned
    // form buildPagesPrompt() actually sent the AI (whitespace-collapsed,
    // hyphenation-repaired) — not the raw page text, so a genuinely
    // verbatim answer isn't rejected just because raw OCR line breaks
    // don't match it. Pane 2's own rendering does its own whitespace
    // normalization on top of this, so highlightSnippetInContainer can
    // still no-op harmlessly if a snippet doesn't line up post-render.
    const pageText = (state.pages.find(p => p.pageNumber === sourcePage) || {}).text || '';
    const cleanedPageText = cleanExtractedText(pageText);
    const questionSnippetRaw = typeof item.questionSnippet === 'string' ? item.questionSnippet : '';
    const answerSnippetRaw = typeof item.answerSnippet === 'string' ? item.answerSnippet : '';
    const sourceSnippet = fuzzyIncludes(cleanedPageText, questionSnippetRaw) ? questionSnippetRaw : '';
    let answerSnippet = fuzzyIncludes(cleanedPageText, answerSnippetRaw) ? answerSnippetRaw : '';
    let targetTerm = typeof item.targetTerm === 'string' ? cleanExtractedText(item.targetTerm) : '';

    // Only Tier 2 items are ever classified as "extension" — Tier 1 and
    // Tier 3 are always standalone "new" definitions.
    let definitionType = 'new';
    if (tier === 2 && item.definitionType === 'extension') {
      const registryKey = normalizeTermKey(targetTerm);
      const parent = registryKey && registry ? registry.get(registryKey) : null;
      if (parent) {
        definitionType = 'extension';
        targetTerm = parent.targetTerm;       // inherit the parent's exact term
        answerSnippet = parent.answerSnippet; // and its exact answer snippet
      }
      // else: named a parent that isn't registered — treat as its own
      // "new" definition instead of leaving it orphaned.
    }

    // Register every "new" definition (from any tier) so later items —
    // in this pass or a subsequent one — can extend it.
    if (definitionType === 'new' && registry) {
      const registryKey = normalizeTermKey(targetTerm);
      if (registryKey && !registry.has(registryKey)) {
        registry.set(registryKey, { targetTerm, answerSnippet });
      }
    }

    state.idCounter += 1;
    cleaned.push({
      id: 'q_' + state.idCounter,
      sourcePage,
      // UPDATE 2A: tags the source this AI-generated question belongs
      // to — see the matching note in question-model.js's newQuestion().
      // Reads state.activeSourceId at the moment each pass's results
      // are parsed, which is correct for both the initial full-document
      // import (main.js makes the new source active before calling
      // generateQuestionsWithAI) and batch-scan.js's page-range scans
      // (which run against whichever source is already active).
      sourceId: state.activeSourceId,
      sourceSnippet,
      answerSnippet,
      targetTerm,
      tier,
      verifyTier: 1,
      // Both snippets were already validated against the page text via
      // fuzzyIncludes above (dropped to '' otherwise) — non-empty here
      // means "found", consistent with verifyTier's own "assumed exact
      // until the next recheck" default.
      sourceFound: !!sourceSnippet,
      answerFound: !!answerSnippet,
      definitionType,
      // UNCHECKED_AI_CONTENT_AND_FUZZY_HIGHLIGHT_PERSISTENCE_PROMPT.md
      // Part B — this is the single place bulk AI-generated question
      // objects are constructed (used by both the initial full-document
      // import and batch-scan.js's page-range/current-page scans, both
      // funneling through generateQuestionsWithAI() -> runTierPass() ->
      // here), so it's the one change point for flagging AI-autogenerated
      // questions "unchecked" until the person actually views them —
      // see newQuestion() in question-model.js for the manually-added
      // default (false) and setActiveCard() in editor-render.js for
      // where this gets cleared.
      aiUnchecked: true,
      activeVariantIndex: 0,
      variants: variantSet,
      generatingType: null,
      variantGenError: null,
    });
  }
  return cleaned;
}

// Calls whichever provider's API with a given system/user prompt pair —
// shared by all 3 tier passes below so the gemini/openai branching
// logic isn't tripled.
// ---------------------------------------------------------------------
// Verbatim from source, lines 4332-4337
// ---------------------------------------------------------------------
async function callAiSystemPrompt(apiKey, provider, model, systemPrompt, userPrompt) {
  if (provider === 'gemini') {
    return await callGeminiApiWithRetry(apiKey, model, systemPrompt, userPrompt);
  }
  return await callOpenAiApi(apiKey, model, systemPrompt, userPrompt);
}

// Runs one tier of the 3-pass scan: sends that tier's system prompt —
// dynamically extended with whatever terms earlier passes have already
// generated (see formatTierSystemPrompt) — then parses + classifies the
// response. A malformed/empty response from this one pass doesn't sink
// the other two — it just contributes zero questions, consistent with
// the rest of the app's philosophy of no-op'ing gracefully on a
// mismatch rather than hard-failing (see highlightSnippetInContainer).
// An outright API-call failure (bad key, network, etc.) still
// propagates, since none of the passes can proceed without a working
// connection.
// ---------------------------------------------------------------------
// Verbatim from source, lines 4349-4368
// ---------------------------------------------------------------------
async function runTierPass(tier, contentPages, apiKey, provider, model, registry, existingTerms) {
  const systemPrompt = formatTierSystemPrompt(TIER_SYSTEM_PROMPTS[tier], existingTerms);
  const userPrompt = 'Here is the extracted document text, broken into pages/slides:\n\n' +
    buildPagesPrompt(contentPages) +
    `\n\nGenerate the Tier ${tier} quiz questions now, following the rules exactly, and return only the JSON object.`;

  let rawText;
  try {
    rawText = await callAiSystemPrompt(apiKey, provider, model, systemPrompt, userPrompt);
  } catch (err) {
    // Issue 1b — a model-not-found failure gets a distinct, actionable
    // message rather than being wrapped the same as any other API
    // failure. This still throws (never swallowed), so
    // generateQuestionsWithAI's sequential `await runTierPass(...)`
    // chain already stops at whichever tier hit this — Tier 2/3 never
    // run against a model that's confirmed to be permanently broken.
    if (provider === 'gemini' && isGeminiModelNotFoundError(err)) {
      const wrapped = new Error(`Tier ${tier}: the selected model ("${model}") is no longer available. Please choose a different model from the dropdown and try again.`);
      wrapped.isModelNotFound = true;
      throw wrapped;
    }
    throw new Error(err.message || `The Tier ${tier} AI request failed. Check your API key, model, and network connection.`);
  }

  try {
    return parseAiQuestions(rawText, contentPages[0].pageNumber, tier, registry);
  } catch (err) {
    console.warn(`Tier ${tier} pass produced no usable questions:`, err);
    return [];
  }
}

// 3-tier sequential scanning pipeline: Pass 1 finds the top-tier
// essential concepts, Pass 2 works page-by-page classifying every
// bullet/detail as a new definition or an extension of one already
// found, and Pass 3 does a final sweep for anything both earlier
// passes missed. Passes run sequentially (not in parallel) both
// because Pass 2's "extension" classification depends on the
// termRegistry that Pass 1 populates, and because Pass 3 is framed as
// a sweep for what Passes 1-2 missed. All 3 results are combined into
// one flat array, preserving this function's original return contract.
// `seedTerms` (optional) pre-populates the accumulated-terms list
// before Pass 1 runs — used by the page-range scan below so a scoped
// re-scan knows about terms already covered by existing questions
// elsewhere in the document, and classifies re-encountered ones as
// "extension" instead of minting duplicate "new" definitions.
// ---------------------------------------------------------------------
// Verbatim from source, lines 4384-4429
// ---------------------------------------------------------------------
async function generateQuestionsWithAI(pages, seedTerms) {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    throw new Error('Please enter your Gemini or OpenAI API key above, then re-upload the file.');
  }
  const provider = apiKey.startsWith('sk-') ? 'openai' : 'gemini';
  const model = modelSelect.value;

  const contentPages = pages.filter(p => p.text && p.text.trim().length > 0);
  if (contentPages.length === 0) {
    throw new Error('No extractable text was found to send to the AI.');
  }

  const termRegistry = new Map();
  // Cumulative term tracking across all 3 passes (see
  // formatTierSystemPrompt above) — reset here, before Pass 1, then
  // extended with each pass's newly generated terms once it completes,
  // so Tier N's prompt always reflects everything Tiers 1..N-1 minted.
  let accumulatedTerms = mergeTerms([], seedTerms || []);
  // Inter-pass throttling: only needed between Gemini passes (OpenAI
  // has no equivalent RPM ceiling here) — keeps sequential requests
  // under Gemini's ~15 RPM free-tier quota on top of the per-call
  // retry/backoff in callGeminiApiWithRetry.
  const INTER_PASS_DELAY_MS = 4000;
  const throttle = () => (provider === 'gemini' ? sleep(INTER_PASS_DELAY_MS) : Promise.resolve());

  setParseStatus('Pass 1 of 3 — scanning for top-tier concepts…');
  const tier1Questions = await runTierPass(1, contentPages, apiKey, provider, model, termRegistry, accumulatedTerms);
  accumulatedTerms = mergeTerms(accumulatedTerms, collectTargetTerms(tier1Questions));
  await throttle();

  setParseStatus('Pass 2 of 3 — scanning bullet-by-bullet detail…');
  const tier2Questions = await runTierPass(2, contentPages, apiKey, provider, model, termRegistry, accumulatedTerms);
  accumulatedTerms = mergeTerms(accumulatedTerms, collectTargetTerms(tier2Questions));
  await throttle();

  setParseStatus('Pass 3 of 3 — final sweep for missed details…');
  const tier3Questions = await runTierPass(3, contentPages, apiKey, provider, model, termRegistry, accumulatedTerms);
  accumulatedTerms = mergeTerms(accumulatedTerms, collectTargetTerms(tier3Questions));

  const questions = [...tier1Questions, ...tier2Questions, ...tier3Questions];
  if (questions.length === 0) {
    throw new Error('The AI did not return any usable questions across all 3 passes. Try a different model or document.');
  }
  return questions;
}

export {
  sleep,
  isGeminiRateLimitError,
  isGeminiModelNotFoundError,
  parseSuggestedRetryDelayMs,
  callGeminiApiWithRetry,
  callOpenAiApi,
  parseAiQuestions,
  callAiSystemPrompt,
  runTierPass,
  generateQuestionsWithAI,
};
