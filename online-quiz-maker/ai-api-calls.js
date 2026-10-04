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

// BATCH 7: provider inference and key checks moved to ai-provider.js. callOpenAiApi gained an optional `{ baseUrl }` (OpenAI-compatible
// endpoint mode, no Authorization header when the key is empty); callAiSystemPrompt(systemPrompt, userPrompt) and
// runTierPass(tier, contentPages, registry, existingTerms) lost their apiKey/provider/model params (resolved inside callAi now).
// BATCH 8: for 'qwen-browser', generateQuestionsWithAI runs each tier once per page window sized to the model's context (qwen-local.js
// planPageChunks), carrying termRegistry/accumulatedTerms across windows; runTierPass's error wrap now preserves isCancelled /
// isContextOverflow / isLocalEndpointError. Hosted providers still send one request per tier.

// --- Shared dependencies ---
import { state } from './core-state.js';
import { setParseStatus } from './status-helpers.js';
import { normalizeTermKey } from './text-normalize.js';
import { callAi, getActiveProvider, getActiveModel, ensureProviderReady, providerNeedsThrottle } from './ai-provider.js';
import { computePageBudgetChars, planPageChunks, getQwenContextWindow } from './qwen-local.js';
import { cleanExtractedText } from './snippet-question-generation.js';
import { fuzzyIncludes, narrowQuestionSnippet } from './highlighting.js';
// Field sync (F6/F10): initFieldSyncBaseline / getClampVariant are only called inside parseAiQuestions' body, so the import cycle is safe.
import { initFieldSyncBaseline, getClampVariant } from './field-sync.js';
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

// Batch 7: OpenAI's own base URL, and the cleaner for a user-typed OpenAI-compatible endpoint URL.
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

// Turns what a person typed into the base URL the /chat/completions and /models paths hang off:
//   "localhost:11434"                 -> "http://localhost:11434/v1"
//   "http://localhost:1234/v1/"       -> "http://localhost:1234/v1"
//   ".../v1/chat/completions"         -> ".../v1"
// A bare host (no path) gets "/v1", which is where Ollama, LM Studio and llama.cpp serve the OpenAI API.
function normalizeOpenAiBaseUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return OPENAI_BASE_URL;
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  url = url.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  try {
    const u = new URL(url);
    if (u.pathname === '' || u.pathname === '/') url = u.origin + '/v1';
  } catch (e) { /* leave as typed; fetch will report it */ }
  return url.replace(/\/+$/, '');
}

// `useJsonMode` defaults to true (existing question-generation callers
// rely on OpenAI's JSON mode). Pass false for callers that want a raw
// text/HTML fragment back instead of a forced { ... } JSON object.
// `options.baseUrl` (Batch 7) points this at any OpenAI-compatible server instead of api.openai.com; with it, an empty `apiKey`
// simply omits the Authorization header, and failures use local-server wording instead of OpenAI's.
// ---------------------------------------------------------------------
// Verbatim from source, lines 4197-4231 (plus the Batch 7 baseUrl/no-key handling)
// ---------------------------------------------------------------------
async function callOpenAiApi(apiKey, model, systemPrompt, userPrompt, useJsonMode = true, options = {}) {
  const isCustom = !!(options && options.baseUrl);
  const baseUrl = isCustom ? normalizeOpenAiBaseUrl(options.baseUrl) : OPENAI_BASE_URL;

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.4,
  };
  if (useJsonMode) body.response_format = { type: 'json_object' };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (netErr) {
    if (!isCustom) throw netErr;
    // fetch() only rejects on network-level failure: server not running, wrong host/port, or the browser blocked it (CORS / mixed content).
    const apiErr = new Error(`Could not reach the endpoint at ${baseUrl}. Check that the server is running, the URL is right, and that it allows this page's origin (CORS).`);
    apiErr.isLocalEndpointError = true;
    throw apiErr;
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch (e) { /* ignore */ }

    if (isCustom) {
      // Some local servers (e.g. LM Studio) reject response_format: json_object; retry once in plain-text mode — the prompts already
      // demand JSON and safeParseAIJson tolerates fences.
      if (useJsonMode && res.status === 400 && /response_format/i.test(detail)) {
        return callOpenAiApi(apiKey, model, systemPrompt, userPrompt, false, options);
      }
      if (res.status === 404 || /model[^.]*\b(not found|not loaded|does not exist|not exist)\b/i.test(detail)) {
        const missing = new Error(`The endpoint doesn't have a model named "${model}" available${detail ? ' (' + detail + ')' : ''}. Pull or load it on the server, or use Detect to see what it serves.`);
        missing.status = res.status;
        missing.isLocalEndpointError = true;
        missing.isModelNotLoaded = true;
        throw missing;
      }
      const endpointErr = new Error(`Endpoint error (${res.status})${detail ? ': ' + detail : '. Check the URL and model name.'}`);
      endpointErr.status = res.status; // not flagged local, so a 429 from a hosted endpoint still reaches handleApiError's quota path
      throw endpointErr;
    }

    const apiErr = new Error(`OpenAI API error (${res.status})${detail ? ': ' + detail : '. Check your API key and model.'}`);
    // Attach the HTTP status so handleApiError's `err.status === 429`
    // check reliably catches an OpenAI rate-limit/quota response even
    // when OpenAI's own error text doesn't happen to say "quota" or
    // "rate limit" verbatim.
    apiErr.status = res.status;
    throw apiErr;
  }
  const data = await res.json();
  let text = data?.choices?.[0]?.message?.content || '';
  // Reasoning-style local models (Qwen3 etc.) may prefix <think>…</think>; it would break JSON parsing and layout HTML.
  if (isCustom) text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!text.trim()) throw new Error(isCustom ? 'The endpoint returned an empty response.' : 'OpenAI returned an empty response.');
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
// Batch 6 — cleaned text of page `pageNum` of the active source (state.pages is the active source's pages), or null if no such page.
function cleanedTextOfPage(pageNum) {
  const page = state.pages.find(p => p.pageNumber === pageNum);
  return page ? cleanExtractedText(page.text || '') : null;
}

// Batch 6 — answer validation chain, first match wins:
//   1. answer inside the container snippet (the SOURCE snippet since the field-sync handoff) -> inside
//   2. answer on the AI-stated answerPage (same source)       -> outside, that page
//   3. answer on any other page of the source, the question's own page first, then the nearest
//      preceding pages, then following pages                  -> outside, that page
//   4. nowhere                                                -> '' (unclassified, never a made-up highlight)
// Returns { answerSnippet, answerScope, answerPage }.
function resolveAnswerLocation(answerRaw, containerSnippet, sourcePage, statedPage) {
  const none = { answerSnippet: '', answerScope: 'inside', answerPage: null };
  if (!answerRaw || !answerRaw.trim()) return none;

  if (containerSnippet && fuzzyIncludes(containerSnippet, answerRaw)) {
    return { answerSnippet: answerRaw, answerScope: 'inside', answerPage: null };
  }

  if (Number.isInteger(statedPage)) {
    const text = cleanedTextOfPage(statedPage); // null for a hallucinated page number
    if (text != null && fuzzyIncludes(text, answerRaw)) {
      return { answerSnippet: answerRaw, answerScope: 'outside', answerPage: statedPage };
    }
  }

  const pageNums = state.pages.map(p => p.pageNumber);
  const preceding = pageNums.filter(n => n < sourcePage).sort((a, b) => b - a);
  const following = pageNums.filter(n => n > sourcePage).sort((a, b) => a - b);
  const order = (pageNums.includes(sourcePage) ? [sourcePage] : []).concat(preceding, following);
  for (const n of order) {
    const text = cleanedTextOfPage(n);
    if (text != null && fuzzyIncludes(text, answerRaw)) {
      return { answerSnippet: answerRaw, answerScope: 'outside', answerPage: n };
    }
  }
  return none;
}

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
    // F10 (replaces D2's "stored in both"): the AI's validated raw snippet is the broad SOURCE container, unchanged. The
    // question snippet is that raw snippet narrowed to the one sentence/bullet the question is about; it is computed below, once the
    // final answer is known. When the raw snippet is already a single sentence the two are legitimately equal.
    const sourceSnippet = fuzzyIncludes(cleanedPageText, questionSnippetRaw) ? questionSnippetRaw : '';
    // Batch 6: the answer is resolved through the inside -> stated page -> other pages -> '' chain instead of a
    // single page check. Only an explicit "outside" scope or a stated page is trusted as a hint; the text itself is
    // always verified against the real page text.
    const statedAnswerPage = Number.isInteger(Number(item.answerPage)) && item.answerPage !== null && item.answerPage !== ''
      ? Number(item.answerPage) : null;
    // Field sync handoff Batch 2: 'inside' is judged against the broad source snippet, not the narrowed question sentence,
    // otherwise an answer in the source but outside the chosen sentence would be stored 'outside' with answerPage === sourcePage.
    const resolved = resolveAnswerLocation(answerSnippetRaw, sourceSnippet, sourcePage, statedAnswerPage);
    let answerSnippet = resolved.answerSnippet;
    let answerScope = resolved.answerScope;
    let answerPage = resolved.answerPage;
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
        // Batch 6: inherit where that answer lives. If the inherited text happens to sit inside this item's own
        // question passage it stays 'inside'; otherwise it is an 'outside' answer on the parent's page, so a later-page
        // extension of an earlier-page term highlights the term where it actually appears instead of silently failing.
        if (!answerSnippet) {
          answerScope = 'inside';
          answerPage = null;
        } else if (sourceSnippet && fuzzyIncludes(sourceSnippet, answerSnippet)) {
          answerScope = 'inside';
          answerPage = null;
        } else {
          const parentText = cleanedTextOfPage(parent.answerPage);
          if (parentText != null && fuzzyIncludes(parentText, answerSnippet)) {
            answerScope = 'outside';
            answerPage = parent.answerPage;
          } else {
            answerSnippet = ''; // can't be placed anywhere — leave unclassified rather than invent a highlight
            answerScope = 'inside';
            answerPage = null;
          }
        }
      }
      // else: named a parent that isn't registered — treat as its own
      // "new" definition instead of leaving it orphaned.
    }

    // Register every "new" definition (from any tier) so later items —
    // in this pass or a subsequent one — can extend it.
    if (definitionType === 'new' && registry) {
      const registryKey = normalizeTermKey(targetTerm);
      if (registryKey && !registry.has(registryKey)) {
        // answerPage here is the page the answer lives on: its own page if outside, else this item's sourcePage.
        registry.set(registryKey, {
          targetTerm,
          answerSnippet,
          answerPage: answerScope === 'outside' ? answerPage : sourcePage,
          answerScope,
        });
      }
    }

    // F10: narrow the broad source snippet to the sentence/bullet the question is about (needs the FINAL answerSnippet, which a Tier 2
    // extension inherits from its parent above). Not narrowed -> the very same string as the source snippet.
    const narrowed = sourceSnippet
      ? narrowQuestionSnippet(sourceSnippet, {
          questionText: (getClampVariant({ variants: variantSet }) || {}).questionText || '',
          answerSnippet,
          targetTerm,
        })
      : { snippet: '', narrowed: false };
    const questionSnippet = narrowed.narrowed ? narrowed.snippet : sourceSnippet;

    state.idCounter += 1;
    const question = {
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
      questionSnippet,
      answerSnippet,
      targetTerm,
      tier,
      verifyTier: 1,
      // Both snippets were already validated against the page text via
      // fuzzyIncludes above (dropped to '' otherwise) — non-empty here
      // means "found", consistent with verifyTier's own "assumed exact
      // until the next recheck" default.
      sourceFound: !!sourceSnippet,
      questionFound: !!questionSnippet,
      answerFound: !!answerSnippet,
      // Set by the Batch 6 answer chain: 'inside' (answer within the source snippet) or 'outside' (on answerPage, same source).
      answerScope,
      answerPage,
      sourceOccurrence: 0,
      questionOccurrence: 0,
      answerOccurrence: 0,
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
    };
    // F6: AI-provided target term / question text start 'synced', so they are not flagged on import.
    initFieldSyncBaseline(question);
    cleaned.push(question);
  }
  return cleaned;
}

// Calls whichever provider is active with a given system/user prompt pair — shared by all 3 tier passes below.
// Batch 7: routing now lives in ai-provider.js's callAi(); this stays as the tier passes' single entry point.
async function callAiSystemPrompt(systemPrompt, userPrompt) {
  return await callAi(systemPrompt, userPrompt, { json: true });
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
async function runTierPass(tier, contentPages, registry, existingTerms) {
  const systemPrompt = formatTierSystemPrompt(TIER_SYSTEM_PROMPTS[tier], existingTerms);
  const userPrompt = 'Here is the extracted document text, broken into pages/slides:\n\n' +
    buildPagesPrompt(contentPages) +
    `\n\nGenerate the Tier ${tier} quiz questions now, following the rules exactly, and return only the JSON object.`;

  let rawText;
  try {
    rawText = await callAiSystemPrompt(systemPrompt, userPrompt);
  } catch (err) {
    // Issue 1b — a model-not-found failure gets a distinct, actionable
    // message rather than being wrapped the same as any other API
    // failure. This still throws (never swallowed), so
    // generateQuestionsWithAI's sequential `await runTierPass(...)`
    // chain already stops at whichever tier hit this — Tier 2/3 never
    // run against a model that's confirmed to be permanently broken.
    if (getActiveProvider() === 'gemini' && isGeminiModelNotFoundError(err)) {
      const model = getActiveModel('gemini');
      const wrapped = new Error(`Tier ${tier}: the selected model ("${model}") is no longer available. Please choose a different model from the dropdown and try again.`);
      wrapped.isModelNotFound = true;
      throw wrapped;
    }
    const rewrapped = new Error(err.message || `The Tier ${tier} AI request failed. Check your API key, model, and network connection.`);
    // Batch 8: keep the local-engine flags so handleApiError / the chunk loop can tell cancel / overflow / local errors apart.
    for (const flag of ['isCancelled', 'isContextOverflow', 'isLocalEndpointError']) if (err && err[flag]) rewrapped[flag] = true;
    throw rewrapped;
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
  // Batch 7: the key check and provider inference moved to ai-provider.js (a key-less provider no longer throws here); the missing-key wording is unchanged.
  const { provider } = ensureProviderReady('Please enter your Gemini or OpenAI API key above, then re-upload the file.');

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
  // and the local providers have no equivalent RPM ceiling here) — keeps
  // sequential requests under Gemini's ~15 RPM free-tier quota on top of
  // the per-call retry/backoff in callGeminiApiWithRetry.
  const INTER_PASS_DELAY_MS = 4000;
  const throttle = () => (providerNeedsThrottle(provider) ? sleep(INTER_PASS_DELAY_MS) : Promise.resolve());

  // Batch 8: hosted providers and endpoints keep the single-request-per-tier behaviour. In-browser Qwen has a ~4k-token context,
  // so each tier runs once per page window (planPageChunks); the term registry and accumulated terms carry across windows.
  const MAX_TERMS_IN_PROMPT = 40; // keep the "already covered" list from eating the small context
  const trimTerms = (t) => (Array.isArray(t) ? t.slice(-MAX_TERMS_IN_PROMPT) : t);
  const runTier = async (tier, label) => {
    if (provider !== 'qwen-browser') {
      const qs = await runTierPass(tier, contentPages, termRegistry, accumulatedTerms);
      accumulatedTerms = mergeTerms(accumulatedTerms, collectTargetTerms(qs));
      return qs;
    }
    const probePrompt = formatTierSystemPrompt(TIER_SYSTEM_PROMPTS[tier], trimTerms(accumulatedTerms));
    const budget = computePageBudgetChars(probePrompt, getQwenContextWindow());
    const chunks = planPageChunks(contentPages, budget);
    const out = [];
    for (let i = 0; i < chunks.length; i++) {
      setParseStatus(`${label}${chunks.length > 1 ? ` — part ${i + 1} of ${chunks.length}` : ''}…`);
      let qs = [];
      try {
        qs = await runTierPass(tier, chunks[i], termRegistry, trimTerms(accumulatedTerms));
      } catch (err) {
        if (err && err.isContextOverflow) { console.warn(`Tier ${tier} part ${i + 1} skipped: context overflow`, err); continue; }
        throw err; // cancel, load failure, WebGPU errors etc. stop the scan
      }
      accumulatedTerms = mergeTerms(accumulatedTerms, collectTargetTerms(qs));
      out.push(...qs);
    }
    return out;
  };

  const tier1Questions = await runTier(1, 'Pass 1 of 3 — scanning for top-tier concepts');
  await throttle();

  const tier2Questions = await runTier(2, 'Pass 2 of 3 — scanning bullet-by-bullet detail');
  await throttle();

  const tier3Questions = await runTier(3, 'Pass 3 of 3 — final sweep for missed details');

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
  normalizeOpenAiBaseUrl,
  parseAiQuestions,
  callAiSystemPrompt,
  runTierPass,
  generateQuestionsWithAI,
};
