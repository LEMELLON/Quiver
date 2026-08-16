// layout-formatting.js
// Extracted verbatim from online-quiz-maker.html, source lines 2823-3001,
// plus the formatLayoutBtn event-wiring line that sits immediately after
// formatAllPagesLayout() at source line 3001 (moved with its handler, per
// the "move with handler" event-wiring strategy used throughout this
// modularization — see MODULARIZATION_SCHEMA.txt).
// Function/const bodies are UNCHANGED from source — only import/export
// wrapper lines were added.
//
// FLAGGED (not moved here, not part of this module): source lines
// 3004-3007, immediately following formatLayoutBtn's wiring —
//   docTextContainer.addEventListener('click', (e) => {
//     const mark = e.target.closest('mark[data-qid]');
//     if (mark) setActiveCard(mark.dataset.qid);
//   });
// This listener isn't assigned to any function in this module (it only
// calls setActiveCard, which belongs to editor-render.js) and isn't
// listed under any module in MODULARIZATION_SCHEMA.txt's proposed-modules
// section either. Per the schema's own instruction ("if something is
// ambiguous, leave it in place / flag it — do not guess-and-rewrite"),
// it has been left out of this extraction rather than guessed into a
// module. It should be picked up explicitly — most likely alongside
// setActiveCard in editor-render.js, or left for the main orchestrator —
// on a later pass.

// --- Shared dependencies ---
import { state } from './core-state.js';
import { docTextContainer, apiKeyInput, modelSelect, formatLayoutBtn } from './dom-refs.js';
import { renderPageTextHtml } from './text-normalize.js';
import { setSelectionGenStatus } from './status-helpers.js';

// Functions from other modules that these functions call:
import { highlightSnippetInContainer, recheckHighlights } from './highlighting.js';
import { callGeminiApiWithRetry, callOpenAiApi, sleep, isGeminiModelNotFoundError } from './ai-api-calls.js';

// ---------------------------------------------------------------------
// Verbatim from source, lines 2823-2864
// ---------------------------------------------------------------------
function renderTextVersion() {
  if (state.pages.length === 0) {
    docTextContainer.innerHTML = `
      <div class="text-center py-20">
        <p class="font-mono text-xs text-mute tracking-wide">No document imported.</p>
        <p class="text-sm text-mute mt-1">Upload a PDF or PPTX in Pane 1 to see its extracted text here.</p>
      </div>`;
    return;
  }
  const lastPageNum = state.pages[state.pages.length - 1].pageNumber;
  docTextContainer.innerHTML = state.pages.map(p => `
    <div class="doc-page" data-page="${p.pageNumber}">
      <div class="doc-page-header">
        <span>Page ${p.pageNumber} of ${lastPageNum}</span>
        <span>${state.docType === 'pptx' ? 'Slide' : 'Doc'}${p.formattedHtml ? ' · AI layout' : ''}</span>
      </div>
      <div class="doc-page-body">${p.formattedHtml || renderPageTextHtml(p.text)}</div>
    </div>
  `).join('');

  // Re-apply highlights for every question that has captured snippets.
  // Sort by tier ascending (1 -> 2 -> 3) first: Tier 1 concepts tend to
  // be the broadest passages, with Tier 2/3 detail snippets landing
  // inside or adjacent to them, so laying down the broader tier-colored
  // marks first lets narrower ones nest inside them correctly. Within a
  // question, the source-passage mark (tier color) goes before the
  // answer mark (always bright green) so that, when the answer text is
  // a substring of the source snippet, the green mark nests correctly
  // inside the tier-colored one.
  [...state.questions].sort((a, b) => (a.tier || 1) - (b.tier || 1)).forEach(q => {
    const pageBody = docTextContainer.querySelector(`.doc-page[data-page="${q.sourcePage}"] .doc-page-body`);
    if (!pageBody) return;
    if (q.sourceSnippet) highlightSnippetInContainer(pageBody, q.sourceSnippet, q.id, 'question', q.tier, 1);
    if (q.answerSnippet) highlightSnippetInContainer(pageBody, q.answerSnippet, q.id, 'answer', q.tier, 1);
  });

  if (state.activeCardId) {
    document.querySelectorAll('mark[data-qid]').forEach(m => {
      m.classList.toggle('active-highlight', m.dataset.qid === state.activeCardId);
    });
  }
}

// =====================================================================
// AI-powered text layout reconstruction: turns the messy raw
// extraction (PDF.js text items / Tesseract OCR) into structured HTML
// that visually approximates the source page's layout — tables, lists,
// headings, columns — while preserving every original word so source
// snippet highlighting still works against it.
// =====================================================================
// ---------------------------------------------------------------------
// Verbatim from source, lines 2874-2882
// ---------------------------------------------------------------------
const LAYOUT_SYSTEM_PROMPT = `You are a document layout-reconstruction assistant embedded in a document-to-quiz tool. You will receive raw, messy text extracted from a single PDF page or PPTX slide (via text extraction or OCR), where the original visual layout — columns, tables, indentation — has been lost and line breaks survive only imperfectly.

Task: re-emit the SAME text as a clean, structured HTML fragment that visually approximates the original layout.

Rules (follow strictly):
1. PRESERVE WORDING EXACTLY: do not add, remove, paraphrase, translate, summarize, or reorder any words. You may only repair broken OCR hyphenation (e.g. "signa- tures" -> "signatures") and normalize incidental whitespace. Every word in your output must be traceable back to the input — this text is later matched verbatim by an exact-substring search, so silent rewording will break that.
2. ALLOWED TAGS ONLY: <p>, <h3>, <h4>, <ul>, <ol>, <li>, <strong>, <em>, <table>, <thead>, <tbody>, <tr>, <th>, <td>, <br>. No other tags, no attributes, no class names, no inline styles, no <script>, no markdown code fences.
3. STRUCTURE: use <table> for tabular or multi-column data, <ul>/<ol> for lists, <h3>/<h4> for headings or section titles, <p> for ordinary paragraphs.
4. OUTPUT FORMAT: reply with ONLY the HTML fragment — no markdown code fences, no commentary, no <html>/<body>/<head> wrapper.`;

// Strips any tag/attribute the AI didn't follow instructions on, so the
// response can be inserted via innerHTML without executing scripts or
// carrying event-handler attributes. Disallowed tags are unwrapped
// (their text content is kept, just not the tag itself) rather than
// deleted outright, so no wording is silently lost.
// ---------------------------------------------------------------------
// Verbatim from source, lines 2889-2911
// ---------------------------------------------------------------------
function sanitizeLayoutHtml(html) {
  const ALLOWED_TAGS = new Set([
    'P', 'H3', 'H4', 'UL', 'OL', 'LI', 'STRONG', 'EM',
    'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'BR',
  ]);
  const template = document.createElement('template');
  template.innerHTML = html;

  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT, null);
  const toUnwrap = [];
  let node;
  while ((node = walker.nextNode())) {
    while (node.attributes.length > 0) node.removeAttribute(node.attributes[0].name);
    if (!ALLOWED_TAGS.has(node.tagName)) toUnwrap.push(node);
  }
  toUnwrap.forEach(el => {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  });
  return template.innerHTML;
}

// Sends one page's raw extracted text to the AI and returns a sanitized
// HTML fragment. Reuses the same provider plumbing (GeminiClassifier /
// callOpenAiApi) and API key as question generation.
// ---------------------------------------------------------------------
// Verbatim from source, lines 2916-2954
// ---------------------------------------------------------------------
async function formatDocumentLayout(rawText) {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) throw new Error('Enter your Gemini or OpenAI API key in Pane 1 first.');
  if (!rawText || !rawText.trim()) return '';

  const provider = apiKey.startsWith('sk-') ? 'openai' : 'gemini';
  const model = modelSelect.value;
  const userPrompt = `Raw extracted text:\n"""\n${rawText}\n"""\n\nReconstruct the layout now, and return only the HTML fragment.`;

  let rawHtml;
  if (provider === 'gemini') {
    rawHtml = await callGeminiApiWithRetry(apiKey, model, LAYOUT_SYSTEM_PROMPT, userPrompt);
  } else {
    // useJsonMode=false: this call wants a raw HTML fragment back, not
    // an OpenAI JSON-mode-wrapped object (which would otherwise force
    // e.g. {"html": "<p>...</p>"} and leak literal JSON syntax onto the page).
    rawHtml = await callOpenAiApi(apiKey, model, LAYOUT_SYSTEM_PROMPT, userPrompt, false);
  }

  let cleaned = (rawHtml || '').replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();

  // Defensive fallback: some models still wrap the answer in a JSON
  // object (e.g. {"html": "..."} or {"content": "..."}) even when not
  // forced into JSON mode. Detect and unwrap that case rather than
  // rendering the raw JSON text onto the page.
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
    try {
      const parsedJson = JSON.parse(cleaned);
      const htmlKey = ['html', 'content', 'fragment', 'result'].find(
        k => typeof parsedJson[k] === 'string' && parsedJson[k].trim()
      );
      if (htmlKey) cleaned = parsedJson[htmlKey].trim();
    } catch (e) {
      // Not actually JSON (just happened to start/end with braces) — leave as-is.
    }
  }

  return sanitizeLayoutHtml(cleaned);
}

// Runs formatDocumentLayout across every page sequentially (kept simple
// and rate-limit-friendly rather than firing them all in parallel),
// stores each result on state.pages[i].formattedHtml, then re-renders
// Pane 2 — renderTextVersion() prefers formattedHtml over the raw
// heuristic renderPageTextHtml() output whenever it's present, and the
// question/answer highlight pass runs against whichever was rendered.
// ---------------------------------------------------------------------
// Verbatim from source, lines 2962-2999
// ---------------------------------------------------------------------
async function formatAllPagesLayout() {
  if (state.pages.length === 0) return;
  formatLayoutBtn.disabled = true;
  formatLayoutBtn.textContent = 'Formatting…';
  setSelectionGenStatus('Reformatting page layout with AI…');

  // Only throttle for Gemini — this loop runs concurrently (unawaited)
  // alongside generateQuestionsWithAI's 3-pass Gemini scan, so without a
  // small per-page pause here the two pipelines combined can still burst
  // past the ~15 RPM free-tier quota even though each call individually
  // retries on 429.
  const apiKeyForThrottle = apiKeyInput.value.trim();
  const isGeminiKey = apiKeyForThrottle && !apiKeyForThrottle.startsWith('sk-');

  try {
    for (const page of state.pages) {
      if (!page.text || !page.text.trim()) continue;
      try {
        page.formattedHtml = await formatDocumentLayout(page.text);
      } catch (err) {
        console.error('Layout formatting failed for page', page.pageNumber, err);
        // GEMINI_FIX_REDO_AND_PPTX_STATE_BUG_PROMPT.md Part A2 — a
        // model-not-found error is permanent: the exact same model ID
        // will 404 on every remaining page too, so retrying it once per
        // page just burns time against a call that can never succeed.
        // Stop the whole batch here instead of continuing to the next
        // page, and tell the person directly so they can pick a
        // different model rather than watching it fail silently once
        // per page in the console.
        if (isGeminiModelNotFoundError(err) || err.isModelNotFound) {
          setSelectionGenStatus(
            `Layout formatting stopped: the selected model is no longer available. Please choose a different model from the dropdown above.`,
            'error'
          );
          break;
        }
        // Any other error: leave this page on its existing heuristic
        // rendering and keep going.
      }
      if (isGeminiKey) await sleep(4000);
    }
    renderTextVersion();
    // Reformatting is the single biggest cause of a highlight going
    // stale (the page's DOM text just changed out from under any
    // snippet captured against the old raw extraction) — so immediately
    // report how many survived instead of a generic "done" message.
    recheckHighlights();
  } catch (err) {
    setSelectionGenStatus(err.message || 'Layout formatting failed.', 'error');
  } finally {
    formatLayoutBtn.disabled = false;
    formatLayoutBtn.textContent = '✨ Format Layout (AI)';
  }
}

// ---------------------------------------------------------------------
// Verbatim from source, line 3001 (event wiring that belongs to this
// module's own function — moved with handler per the schema's strategy)
// ---------------------------------------------------------------------
formatLayoutBtn.addEventListener('click', formatAllPagesLayout);

export {
  renderTextVersion,
  sanitizeLayoutHtml,
  formatDocumentLayout,
  formatAllPagesLayout,
};
