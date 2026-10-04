import { state, getDuplicateMap, setDuplicateMap } from './core-state.js';
import { docTextContainer } from './dom-refs.js';
import { renderPageTextHtml } from './text-normalize.js';
import { setSelectionGenStatus } from './status-helpers.js';

import { highlightSnippetInContainer, recheckHighlights, dedupeMarks, logAllHighlights, locateAndHighlightSnippet, markQidList } from './highlighting.js';
import { sleep, isGeminiModelNotFoundError } from './ai-api-calls.js';
import { callAi, getActiveProvider, providerNeedsThrottle, ensureProviderReady, isProviderConfigured } from './ai-provider.js';
// Cross-module import cycle with question-model.js; safe since computeDuplicateMap is only called inside a function body, never at module-evaluation time.
import { computeDuplicateMap } from './question-model.js';

// Rebuilds Pane 2's HTML from state.pages and re-applies question/answer highlights; returns a qid -> {source, question, answer} results map.
function renderTextVersion() {
  if (state.pages.length === 0) {
    docTextContainer.innerHTML = `
      <div class="text-center py-20">
        <p class="font-mono text-xs text-mute tracking-wide">No document imported.</p>
        <p class="text-sm text-mute mt-1">Upload a PDF or PPTX in Pane 1 to see its extracted text here.</p>
      </div>`;
    // Empty map keeps the return type consistent for every caller, even when there's nothing to render.
    return new Map();
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

  // Draw order (D4): source marks first (longest first, so a shorter source nests inside a longer one), then question marks in
  // tier order, then answer marks, so narrower marks always nest inside broader ones.
  // Refresh the duplicate map right before drawing so overlapping marks from duplicate questions share correctly instead of nesting/hiding one.
  setDuplicateMap(computeDuplicateMap());
  // qid -> { source, question, answer } ladder results (each LadderResult|null), collected so recheckHighlights() can rebuild
  // each question's verify status from a full rebuild. ctxByQid carries each question's resolved parent ranges between passes.
  const results = new Map();
  const ctxByQid = new Map();
  // Only the active source's pages exist in this DOM, so other sources' questions can never match here.
  const active = state.questions.filter(q => q.sourceId === state.activeSourceId);
  active.forEach(q => {
    results.set(q.id, { source: null, question: null, answer: null });
    ctxByQid.set(q.id, {});
  });
  const draw = (q, type) => {
    results.get(q.id)[type] = locateAndHighlightSnippet(docTextContainer, q, type, 1, ctxByQid.get(q.id));
  };

  [...active].filter(q => q.sourceSnippet)
    .sort((a, b) => b.sourceSnippet.length - a.sourceSnippet.length)
    .forEach(q => draw(q, 'source'));
  const byTier = [...active].sort((a, b) => (a.tier || 1) - (b.tier || 1));
  byTier.filter(q => q.questionSnippet).forEach(q => draw(q, 'question'));
  byTier.filter(q => q.answerSnippet).forEach(q => draw(q, 'answer'));

  // Safety net: this function rebuilds innerHTML above, so there shouldn't be pre-existing marks to straddle, but guard against that assumption breaking.
  dedupeMarks(docTextContainer);

  logAllHighlights('end of renderTextVersion');

  // Keeps each mark's active/unchecked classes in sync; markQidList reads every id a shared duplicate-pair mark carries, since a mark can hold more than one qid.
  document.querySelectorAll('mark[data-qid]').forEach(m => {
    const ids = markQidList(m);
    m.classList.toggle('active-highlight', ids.includes(state.activeCardId));
    const showUnchecked = ids.some(mid => {
      const markQ = state.questions.find(x => x.id === mid);
      const markDup = markQ && getDuplicateMap().get(markQ.id);
      return !!(markQ && markQ.aiUnchecked && !markDup);
    });
    m.classList.toggle('unchecked-highlight', showUnchecked);
  });

  return results;
}

// Converts raw PDF/OCR text extraction into structured HTML that visually approximates the source page's layout, while preserving every original word for highlighting.
const LAYOUT_SYSTEM_PROMPT = `You are a document layout-reconstruction assistant embedded in a document-to-quiz tool. You will receive raw, messy text extracted from a single PDF page or PPTX slide (via text extraction or OCR), where the original visual layout — columns, tables, indentation — has been lost and line breaks survive only imperfectly.

Task: re-emit the SAME text as a clean, structured HTML fragment that visually approximates the original layout.

Rules (follow strictly):
1. PRESERVE WORDING EXACTLY: do not add, remove, paraphrase, translate, summarize, or reorder any words. You may only repair broken OCR hyphenation (e.g. "signa- tures" -> "signatures") and normalize incidental whitespace. Every word in your output must be traceable back to the input — this text is later matched verbatim by an exact-substring search, so silent rewording will break that.
2. ALLOWED TAGS ONLY: <p>, <h3>, <h4>, <ul>, <ol>, <li>, <strong>, <em>, <table>, <thead>, <tbody>, <tr>, <th>, <td>, <br>. No other tags, no attributes, no class names, no inline styles, no <script>, no markdown code fences.
3. STRUCTURE: use <table> for tabular or multi-column data, <ul>/<ol> for lists, <h3>/<h4> for headings or section titles, <p> for ordinary paragraphs.
4. OUTPUT FORMAT: reply with ONLY the HTML fragment — no markdown code fences, no commentary, no <html>/<body>/<head> wrapper.`;

// Strips disallowed tags/attributes from AI HTML output (unwrapping content rather than deleting it) so it's safe to insert via innerHTML.
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

// Sends one page's raw extracted text to the AI and returns a sanitized HTML fragment, reusing the same provider plumbing and API key as question generation.
async function formatDocumentLayout(rawText) {
  ensureProviderReady(); // throws the "enter your key" / "enter the endpoint" message when the active provider isn't usable yet
  if (!rawText || !rawText.trim()) return '';

  const userPrompt = `Raw extracted text:\n"""\n${rawText}\n"""\n\nReconstruct the layout now, and return only the HTML fragment.`;

  // json: false — this call wants a raw HTML fragment back, not an OpenAI JSON-mode-wrapped object.
  const rawHtml = await callAi(LAYOUT_SYSTEM_PROMPT, userPrompt, { json: false });

  let cleaned = (rawHtml || '').replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();

  // Some models still wrap the answer in a JSON object even when not forced into JSON mode; unwrap known keys instead of rendering raw JSON.
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

// Runs formatDocumentLayout across every page sequentially, stores each result on state.pages[i].formattedHtml, then re-renders Pane 2.
async function formatAllPagesLayout() {
  if (state.pages.length === 0) return;
  setSelectionGenStatus('Reformatting page layout with AI…');

  // Throttle only for Gemini: this loop runs concurrently with the 3-pass Gemini question-generation scan, and together they can exceed the ~15 RPM free-tier quota.
  // Batch 7: decided by the active provider (ai-provider.js), not the key prefix; with nothing configured there are no calls to throttle.
  const needsThrottle = isProviderConfigured() && providerNeedsThrottle(getActiveProvider());

  try {
    for (const page of state.pages) {
      if (!page.text || !page.text.trim()) continue;
      try {
        page.formattedHtml = await formatDocumentLayout(page.text);
      } catch (err) {
        console.error('Layout formatting failed for page', page.pageNumber, err);
        // Model-not-found is permanent, so stop the whole batch and tell the user rather than retrying on every remaining page.
        if (isGeminiModelNotFoundError(err) || err.isModelNotFound) {
          setSelectionGenStatus(
            `Layout formatting stopped: the selected model is no longer available. Please choose a different model from the dropdown above.`,
            'error'
          );
          break;
        }
        // Any other error: leave this page on its existing heuristic rendering and keep going.
      }
      if (needsThrottle) await sleep(4000);
    }
    // No explicit render call here: recheckHighlights() below does its own full rebuild, covering both the re-render and the highlight-survival report.
    recheckHighlights();
    logAllHighlights('formatAllPagesLayout: after recheckHighlights (final)');
  } catch (err) {
    setSelectionGenStatus(err.message || 'Layout formatting failed.', 'error');
  }
}

export {
  renderTextVersion,
  sanitizeLayoutHtml,
  formatDocumentLayout,
  formatAllPagesLayout,
};
