// ai-prompt-builders.js
// Extracted verbatim from online-quiz-maker.html (module [12] per
// MODULARIZATION_SCHEMA.txt): buildTierSystemPrompt, collectTargetTerms,
// mergeTerms, formatTierSystemPrompt, buildPagesPrompt, safeParseAIJson.
// Function/const bodies are UNCHANGED from source — only import/export
// wrapper lines were added.
//
// SOURCE LINE RANGES (in original file order):
//   3950-3957  TIER_FOCUS               (pulled in — see NOTE)
//   3959-4015  buildTierSystemPrompt
//   4021-4024  TIER1/2/3_SYSTEM_PROMPT + TIER_SYSTEM_PROMPTS (pulled in — see NOTE)
//   4045-4056  collectTargetTerms
//   4061-4071  mergeTerms
//   4079-4092  formatTierSystemPrompt
//   4094-4100  buildPagesPrompt
//   4102-4119  safeParseAIJson
//
// NOTE (structural, not a logic change): TIER_FOCUS (source lines
// 3950-3957) isn't in the schema's named function list for this module,
// but it's a constant used ONLY by buildTierSystemPrompt below — same
// "constant moves with its sole usage site" precedent already applied to
// SNIPPET_SYSTEM_PROMPT in snippet-question-generation.js and
// DUPLICATE_SNIPPET_MIN_LEN in question-model.js. Included here,
// unchanged, immediately before the function that reads it.
//
// NOTE (structural, not a logic change): TIER1_SYSTEM_PROMPT,
// TIER2_SYSTEM_PROMPT, TIER3_SYSTEM_PROMPT, and TIER_SYSTEM_PROMPTS
// (source lines 4021-4024) are likewise not in the schema's named
// function list, but they're the module-load-time result of calling
// buildTierSystemPrompt(1/2/3) once each — TIER_SYSTEM_PROMPTS is then
// read by runTierPass in ai-api-calls.js (source line 4350). Same
// "moves with its sole usage/definition site" precedent — included here
// verbatim and exported so ai-api-calls.js can import it.

// --- Shared dependencies ---
import { normalizeTermKey } from './text-normalize.js';
import { cleanExtractedText } from './snippet-question-generation.js';

// Builds the system prompt for one pass of the 3-tier scanning
// pipeline (see generateQuestionsWithAI). All 3 tiers share the same
// output schema and clamp/rephrased/true_false variant rules — only
// the FOCUS instructions (what to look for and how much of it) differ,
// plus Tier 2 additionally asks the model to classify each collection
// as a "new" definition or an "extension" of an already-identified one.
// ---------------------------------------------------------------------
// Verbatim from source, lines 3950-3957
// ---------------------------------------------------------------------
const TIER_FOCUS = {
  1: `This is PASS 1 of a 3-pass scan — TIER 1 (top-tier essentials). Scan the ENTIRE document and identify only the small handful of most important, high-level terms and concepts a student absolutely must know to understand the material at all. Be selective: skip minor details, examples, and individual supporting bullet points — those belong to later passes. Every collection from this pass is a brand-new, standalone definition.`,
  2: `This is PASS 2 of a 3-pass scan — TIER 2 (bullet-by-bullet detail). Go through the document page by page / slide by slide and evaluate EVERY bullet point or distinct detail block in turn — one bullet/item at a time, never a whole list or block at once. For each one, classify it as either:
   a) "new" — it introduces a term/concept not already covered (by an earlier bullet in this pass, or by a Tier 1 concept from Pass 1). Give it its own distinct targetTerm, answerSnippet, and questionSnippet, with questionSnippet scoped to ONLY that one bullet/item's own text (see the SOURCE SNIPPETS rule below — never the surrounding list).
   b) "extension" — it adds detail, an example, or elaboration onto a term that's already been established (by an earlier bullet in this pass, or by a Tier 1 concept). In this case reuse that SAME targetTerm and SAME answerSnippet verbatim (copy them exactly as previously used — do not paraphrase or reword them), and set questionSnippet to this specific bullet/detail's own passage ONLY, not the original definition's passage and not any neighboring bullets.
   Return this classification as "definitionType": "new" or "extension" for every collection in this pass.`,
  3: `This is PASS 3 of a 3-pass scan — TIER 3 (final sweep). Re-read the entire document one last time and pick up any remaining minor details, asides, or small facts that a careful reviewer would still want a quiz question for, but that don't rise to the level of Tier 1 or Tier 2 material. These are lower-priority items for review — keep the same JSON shape and quality bar (verbatim snippets, self-contained stems), just cast a wider net for anything a less exhaustive pass would still miss.`,
};

// ---------------------------------------------------------------------
// Verbatim from source, lines 3959-4015
// ---------------------------------------------------------------------
function buildTierSystemPrompt(tier) {
  const definitionTypeSchemaLine = tier === 2
    ? `      "definitionType": "string — \\"new\\" or \\"extension\\" (see PASS 2 rules above)",\n`
    : '';
  const definitionTypeRuleLine = tier === 2
    ? `7. DEFINITION TYPE: classify every collection as "new" or "extension" per the PASS 2 instructions above, and return it as "definitionType".\n`
    : '';
  const coverageInstruction = tier === 1
    ? 'aim for only the most important handful of concepts across the WHOLE document (roughly 3-10 total) — prioritize importance over quantity.'
    : tier === 2
    ? 'aim to cover every substantive bullet/detail block on every page/slide; skip pages with no real content (blank slides, section dividers, pure images).'
    : 'pick up whatever substantive material Passes 1 and 2 would plausibly have missed; skip pages with no real content.';

  return `You are a quiz-writing assistant embedded in a document-to-quiz tool. You will receive raw text extracted from a PDF or PPTX document, broken into pages/slides. The text may contain OCR or extraction artifacts.

Work definition-first: for each substantive term or concept worth testing, build a "question collection" starting with a fill-in-the-blank ("clamp") question that tests the target term, then return the collections as a single JSON object. (Other question variants for the same term — rephrased MCQ, true/false — are generated later, on demand, elsewhere in the app; you only need to produce the clamp variant here.)

${TIER_FOCUS[tier]}

For each collection, based strictly on the source material:
1. Identify the target term/concept and where it is defined or explained on that page/slide.
2. CLAMP variant (sentence-continuation / fill-in-the-blank): write ONE full declarative sentence that states or closely paraphrases the material's definition of the term, with the target term itself as the sentence's leading subject — e.g. "Encapsulation is the bundling of data and methods that operate on that data...". Do NOT phrase this as a question and do NOT omit the term; the app strips the leading term to build the blank, so the term must be the very first words of the sentence. It also needs 4 answer choices (one of them the target term itself, i.e. what fills the blank) with exactly one correct answer.

Rules (follow strictly):
1. SELF-CONTAINED CONTENT: every clamp sentence must explicitly name enough context to be understood with no access to the source document. Never write vague or contextless stems like "What is this?".
2. CLEAN TEXT: the source text may contain OCR hyphenation errors (e.g. "signa- tures" instead of "signatures") or stray line breaks. Silently repair these; never reproduce a broken hyphenation or stray line break in a sentence or choice.
3. CHOICE COUNTS: 4 choices by default (no fixed upper limit — a few more are fine if the concept genuinely calls for it, but never fewer than 2).
4. COVERAGE: ${coverageInstruction}
5. SOURCE SNIPPETS — STRICT SINGLE-ITEM BOUNDARIES: for each collection also return "questionSnippet" and "answerSnippet" — both must be exact substrings copied verbatim character-for-character from that page's original source text (same spelling, spacing, and line breaks as given to you), NOT paraphrased or cleaned up:
   - "questionSnippet": ONLY the single sentence, line, or bullet/numbered item that THIS collection's question is actually drawn from — never more than that one item, even when it sits inside a longer list or block of several definitions.
     * FORBIDDEN: if the source is a numbered or bulleted list of several definitions/items — e.g. "1 Peripheral Devices - A computer peripheral is any external device that provides input and output for the computer. 2 Central Processing Unit (CPU) - This is... 3 Mass Storage System - Memory..." — do NOT return the whole numbered block as "questionSnippet". A collection about "Peripheral Devices" must get ONLY "Peripheral Devices - A computer peripheral is any external device that provides input and output for the computer." as its questionSnippet — stop before the next list item's number/bullet begins, and never include text belonging to a different targetTerm's item.
     * The only time "questionSnippet" may span more than one line is when a single item's own definition legitimately wraps across a line break in the source — it must still end the instant the next bullet/number/item begins, not before.
     * Each bullet or numbered item in a list produces its OWN separate collection with its OWN narrowly-scoped questionSnippet — never merge several list items into one collection's snippet just because they're adjacent in the source.
   - "answerSnippet": the exact substring (usually shorter, often contained within questionSnippet) that names or states the target term/answer as it literally appears in the source — the same single-item boundary rule applies; it must never spill into a neighboring list item either.
   If you cannot find a true verbatim substring for either that respects these boundaries, return an empty string for it rather than inventing one or widening the snippet to the whole paragraph/list to "play it safe".
6. OUTPUT FORMAT: reply with ONLY a single JSON object, no markdown code fences and no commentary, in exactly this shape:
${definitionTypeRuleLine}
{
  "collections": [
    {
      "targetTerm": "string — the key term or concept",
      "sourcePage": 1,
      "questionSnippet": "string — exact verbatim substring of the source page, ONLY this one sentence/bullet/numbered item — never the surrounding list or block it's part of (or \"\")",
      "answerSnippet": "string — exact verbatim substring of the source page, same single-item boundary as questionSnippet (or \"\")",
${definitionTypeSchemaLine}      "variants": {
        "clamp": {
          "sentence": "string — one full sentence, target term as its leading subject, e.g. 'TargetTerm is a ...'",
          "choices": ["string", "string", "string", "string"],
          "correctAnswerIndex": 0
        }
      }
    }
  ]
}

"correctAnswerIndex" is an integer indexing into the clamp variant's "choices" array. "sourcePage" must match the page/slide number the collection was drawn from.`;
}

// Three distinct, named system prompts — one per pass — built from the
// shared template above so the schema/rules text can't drift between
// them while the FOCUS/coverage/definitionType instructions stay
// genuinely different per tier.
// ---------------------------------------------------------------------
// Verbatim from source, lines 4021-4024
// ---------------------------------------------------------------------
const TIER1_SYSTEM_PROMPT = buildTierSystemPrompt(1);
const TIER2_SYSTEM_PROMPT = buildTierSystemPrompt(2);
const TIER3_SYSTEM_PROMPT = buildTierSystemPrompt(3);
const TIER_SYSTEM_PROMPTS = { 1: TIER1_SYSTEM_PROMPT, 2: TIER2_SYSTEM_PROMPT, 3: TIER3_SYSTEM_PROMPT };

// =====================================================================
// Dynamic prompting: cumulative term tracking across Tier 1 -> 2 -> 3.
//
// generateQuestionsWithAI keeps a single running array of every
// targetTerm generated so far in the current bulk-generation run (reset
// at the start of that run, extended after each pass completes). Before
// each pass's system prompt is sent, formatTierSystemPrompt() appends an
// exclusion block listing those terms, so — since the passes run
// strictly sequentially — Tier 2 always sees everything Tier 1 minted,
// and Tier 3 sees everything Tier 1 + Tier 2 minted, cutting down on
// duplicate "new" definitions for a term a prior pass already covered.
// =====================================================================

// Cleans + dedupes (punctuation/case-insensitively) the targetTerms a
// just-finished pass produced, for folding into the running
// accumulated-terms array. Uses normalizeTermKey rather than a bare
// .toLowerCase() so two mentions of the same term that only differ in
// trailing punctuation, quote style, or a dash variant still collapse
// to one entry instead of both surviving as "distinct" terms.
// ---------------------------------------------------------------------
// Verbatim from source, lines 4045-4056
// ---------------------------------------------------------------------
function collectTargetTerms(questions) {
  const seen = new Set();
  const out = [];
  for (const q of questions || []) {
    const term = cleanExtractedText(q.targetTerm || '');
    const key = normalizeTermKey(term);
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

// Merges `newTerms` into `existingTerms`, skipping anything already
// present (punctuation/case-insensitively — see normalizeTermKey) so
// the accumulated list never grows duplicate entries across passes.
// ---------------------------------------------------------------------
// Verbatim from source, lines 4061-4071
// ---------------------------------------------------------------------
function mergeTerms(existingTerms, newTerms) {
  const seen = new Set(existingTerms.map(t => normalizeTermKey(t)));
  const merged = existingTerms.slice();
  for (const term of newTerms) {
    const key = normalizeTermKey(term);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(term);
  }
  return merged;
}

// Builds the system prompt actually sent for a given pass: the tier's
// static base prompt, plus — once at least one term has been generated
// by an earlier pass — an appended exclusion block naming every term
// covered so far, instructing the model not to re-mint "new"
// definitions for them and to classify re-encountered terms as
// extension/review material instead.
// ---------------------------------------------------------------------
// Verbatim from source, lines 4079-4092
// ---------------------------------------------------------------------
function formatTierSystemPrompt(basePrompt, existingTerms) {
  if (!existingTerms || existingTerms.length === 0) return basePrompt;
  const termList = existingTerms.map(t => `- ${t}`).join('\n');
  return `${basePrompt}

CRITICAL CONSTRAINT - PREVIOUSLY COVERED TERMS:
The following terms have ALREADY been processed in earlier passes:
${termList}

RULES FOR THESE TERMS:
- Do NOT generate new definitions for any terms in this list.
- If you encounter these terms again in the text, you MUST classify them as "extension" (or "review") rather than "new".
- Focus primary generation efforts on novel concepts not present in the list above.`;
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 4094-4100
// ---------------------------------------------------------------------
function buildPagesPrompt(pages) {
  const MAX_CHARS_PER_PAGE = 6000;
  return pages.map(p => {
    const cleaned = cleanExtractedText(p.text).slice(0, MAX_CHARS_PER_PAGE);
    return `--- Page ${p.pageNumber} ---\n${cleaned}`;
  }).join('\n\n');
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 4102-4119
// ---------------------------------------------------------------------
function safeParseAIJson(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const wrappedJson = cleaned.match(/\{[\s\S]*\}/);
    if (wrappedJson) {
      try { return JSON.parse(wrappedJson[0]); } catch (e2) { return null; }
    }
    return null;
  }
}

export {
  buildTierSystemPrompt,
  TIER_SYSTEM_PROMPTS,
  collectTargetTerms,
  mergeTerms,
  formatTierSystemPrompt,
  buildPagesPrompt,
  safeParseAIJson,
};
