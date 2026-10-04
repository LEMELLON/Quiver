import { state } from './core-state.js';
import { MIN_CHOICES } from './shared-constants.js';
import { toClampPrompt } from './question-model.js';
import { cleanExtractedText } from './snippet-question-generation.js';
import { callAi, ensureProviderReady } from './ai-provider.js';
import { safeParseAIJson } from './ai-prompt-builders.js';
import { renderActiveQuestion } from './editor-render.js';

// true_false requires exactly 2 choices; every other type just needs at least MIN_CHOICES.
function isValidChoiceCount(type, n) {
  if (type === 'true_false') return n === 2;
  return Number.isInteger(n) && n >= MIN_CHOICES;
}

// Validates and normalizes a raw AI/manual variant into the { type, questionText, choices, correctAnswerIndex(es) } shape.
function normalizeVariant(raw, type) {
  if (!raw || typeof raw.questionText !== 'string' || !raw.questionText.trim()) return null;
  if (!Array.isArray(raw.choices) || !isValidChoiceCount(type, raw.choices.length)) return null;
  const choices = raw.choices.map(c => cleanExtractedText(String(c ?? '')));
  if (choices.some(c => !c)) return null;
  const choiceCount = choices.length;

  if (type === 'category') {
    if (!Array.isArray(raw.correctAnswerIndices) || raw.correctAnswerIndices.length === 0) return null;
    const seen = new Set();
    for (const n of raw.correctAnswerIndices) {
      const idx = Number(n);
      if (!Number.isInteger(idx) || idx < 0 || idx >= choiceCount) return null;
      seen.add(idx);
    }
    return {
      type,
      questionText: cleanExtractedText(raw.questionText),
      choices,
      correctAnswerIndex: 0, // unused for category, kept for shape consistency
      correctAnswerIndices: Array.from(seen).sort((a, b) => a - b),
    };
  }

  const correctAnswerIndex = Number(raw.correctAnswerIndex);
  if (!Number.isInteger(correctAnswerIndex) || correctAnswerIndex < 0 || correctAnswerIndex >= choiceCount) return null;
  return {
    type,
    questionText: cleanExtractedText(raw.questionText),
    choices,
    correctAnswerIndex,
  };
}

// Normalizes a raw clamp variant (sentence + choices) into the standard variant shape via toClampPrompt.
function normalizeClampVariant(raw, targetTerm) {
  if (!raw || typeof raw.sentence !== 'string' || !raw.sentence.trim()) return null;
  const sentence = cleanExtractedText(raw.sentence);
  const questionText = toClampPrompt(sentence, targetTerm);
  if (!questionText) return null;

  if (!Array.isArray(raw.choices) || !isValidChoiceCount('clamp', raw.choices.length)) return null;
  const choices = raw.choices.map(c => cleanExtractedText(String(c ?? '')));
  if (choices.some(c => !c)) return null;
  const correctAnswerIndex = Number(raw.correctAnswerIndex);
  if (!Number.isInteger(correctAnswerIndex) || correctAnswerIndex < 0 || correctAnswerIndex >= choices.length) return null;

  return { type: 'clamp', questionText, choices, correctAnswerIndex };
}

// Extracts and normalizes the clamp variant from a parsed AI response, accepting array or object variant shapes.
function parseClampVariantSet(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.variants) return null;
  const v = parsed.variants;
  let rawClamp = null;
  if (Array.isArray(v)) {
    const item = v.find(x => x && x.type === 'clamp');
    rawClamp = item || null;
  } else if (typeof v === 'object') {
    rawClamp = v.clamp || null;
  }
  const targetTerm = typeof parsed.targetTerm === 'string' ? cleanExtractedText(parsed.targetTerm) : '';
  const clamp = normalizeClampVariant(rawClamp, targetTerm);
  if (!clamp) return null;
  return [clamp];
}

// System prompts for on-demand single-variant generation (rephrased/true_false/category) via the per-question "Generate" buttons.
const SINGLE_VARIANT_SYSTEM_PROMPTS = {
  rephrased: `You are a quiz-writing assistant embedded in a document-to-quiz tool. You'll be given a target term/concept and a passage of context (either the original source snippet or an existing question about the term). Write ONE new "rephrased" multiple-choice question variant testing the same target term.

Rules (follow strictly):
1. It must be a differently-worded conceptual or scenario-style question — ask about the term from a different angle, never just reword the given context into a question.
2. SELF-CONTAINED: the question stem must be understandable with no access to the source document.
3. Base it strictly on the given context — never introduce facts that are not present in it.
4. 4 unique answer choices by default (no fixed upper limit — a few more are fine if the concept genuinely calls for it, but never fewer than 2), with exactly one correct answer.
5. If a list of existing variants to avoid is given, do not repeat or closely reword any of them.
6. OUTPUT FORMAT: reply with ONLY a single JSON object, no markdown code fences and no commentary, in exactly this shape:

{
  "questionText": "string — a differently-worded conceptual/scenario question",
  "choices": ["string", "string", "string", "string"],
  "correctAnswerIndex": 0
}

"correctAnswerIndex" is an integer indexing into "choices".`,

  true_false: `You are a quiz-writing assistant embedded in a document-to-quiz tool. You'll be given a target term/concept and a passage of context (either the original source snippet or an existing question about the term). Write ONE new "true/false" question variant testing the same target term.

Rules (follow strictly):
1. It must be a single declarative statement derived from the context (which may be true or false) — not a question, and not a copy of an existing statement about the term.
2. SELF-CONTAINED: the statement must be understandable with no access to the source document.
3. Base it strictly on the given context — never introduce facts that are not present in it.
4. Choices are exactly ["True", "False"].
5. If a list of existing variants to avoid is given, do not repeat or closely reword any of them.
6. OUTPUT FORMAT: reply with ONLY a single JSON object, no markdown code fences and no commentary, in exactly this shape:

{
  "questionText": "string — a true/false statement derived from the context",
  "choices": ["True", "False"],
  "correctAnswerIndex": 0
}

"correctAnswerIndex" is an integer indexing into "choices" (0 for True, 1 for False).`,

  category: `You are a quiz-writing assistant embedded in a document-to-quiz tool. You'll be given a target term/concept and a passage of context (either the original source snippet or an existing question about the term). Write ONE new "Category Selection" question variant testing the same target term — a "select every correct answer" style multiple-choice question where more than one choice can be correct.

Examples of the style (for tone only — do not reuse their content unless it matches the given context):
- "What are these Classifications of Software?" with correct choices like "System Software" and "Operating System" alongside an incorrect distractor.
- "What are the Components of a Computer?" with correct choices like "Hardware", "Software", and "People Ware" alongside an incorrect distractor.
- A passage that names several sub-items under one umbrella concept — e.g. a "Threats to Databases" passage that says threats can cause loss/degradation of integrity, availability, and confidentiality — makes a natural category question: "Threats to databases can result in the loss or degradation of which of the following commonly accepted security goals?" with correct choices "Loss of integrity", "Loss of availability", and "Loss of confidentiality" alongside an incorrect distractor. Recognize this "umbrella term + enumerated sub-items" shape wherever it appears in the given context, not just for security topics.

Rules (follow strictly):
1. The question stem must ask the reader to identify ALL items from a category, list, or classification that are correct — not a single fact.
2. SELF-CONTAINED: the question stem must be understandable with no access to the source document.
3. Base it strictly on the given context — never introduce facts that are not present in it.
4. 4 choices is the usual default, but there is NO fixed upper limit: if the category genuinely enumerates more than 4 correct sub-items in the given context, include ALL of them as their own choices, plus at least 1 incorrect distractor — never omit or merge genuine sub-items just to stay at 4. Never fewer than 2 choices total. At least 2 choices must be correct (this is a multi-select question, not a single-answer one) — but not necessarily all of them; include at least 1 plausible incorrect distractor when the context supports one.
5. If a list of existing variants to avoid is given, do not repeat or closely reword any of them.
6. OUTPUT FORMAT: reply with ONLY a single JSON object, no markdown code fences and no commentary, in exactly this shape:

{
  "questionText": "string — a \\"select all that apply\\" question",
  "choices": ["string", "string", "string", "string"],
  "correctAnswerIndices": [0, 1]
}

"choices" should have as many entries as the category genuinely has (4 by default, more if the context supports it — no upper limit). "correctAnswerIndices" is an array of integers indexing into "choices", length at least 2, up to the full choice count.`,
};

// Generates one normalized variant of the given type for question q, using its snippet or existing variant text as context.
async function generateSingleVariant(q, type, statusElement) {
  ensureProviderReady(); // throws the "enter your key" / "enter the endpoint" message when the active provider isn't usable yet

  // Prefer the clamp variant's text as context if present, else fall back to whichever variant is on hand.
  const clamp = q.variants.find(v => v.type === 'clamp');
  const fallbackVariant = clamp || q.variants[0];
  const contextText = q.sourceSnippet || (fallbackVariant && fallbackVariant.questionText) || '';
  if (!contextText.trim()) {
    throw new Error("Add a source snippet or fill in a question first — there's nothing to generate from yet.");
  }

  const systemPrompt = SINGLE_VARIANT_SYSTEM_PROMPTS[type];

  const existingOfType = q.variants.filter(v => v.type === type).map(v => v.questionText).filter(Boolean);
  const avoidBlock = existingOfType.length
    ? `\n\nExisting variants of this same type to avoid repeating or closely rewording:\n${existingOfType.map(t => `- ${t}`).join('\n')}`
    : '';
  const userPrompt = `Target term: "${q.targetTerm || '(not explicitly given — infer it from the context below)'}"
Context (use ONLY this for facts):
"""
${contextText}
"""${q.answerSnippet ? `\nKnown answer/definition snippet: "${q.answerSnippet}"` : ''}${avoidBlock}

Generate the question variant now, and return only the JSON object.`;

  let rawText;
  try {
    rawText = await callAi(systemPrompt, userPrompt);
  } catch (err) {
    if (handleApiError(err, statusElement)) {
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

  const variant = normalizeVariant(parsed, type);
  if (!variant) throw new Error('The AI response was not a usable question variant. Try again.');
  return variant;
}

// Click handler for the variant-generation tabs/chip; guards against concurrent calls and appends the new variant on success.
async function handleGenerateVariant(qid, type) {
  const q = state.questions.find(x => x.id === qid);
  if (!q || q.generatingType) return;

  q.generatingType = type;
  q.variantGenError = null;
  renderActiveQuestion();

  try {
    const variant = await generateSingleVariant(q, type, (msg, tone) => {
      if (tone === 'error') q.variantGenError = msg;
    });
    q.variants.push(variant);
    q.activeVariantIndex = q.variants.length - 1;
  } catch (err) {
    console.error(err);
    q.variantGenError = err.message || 'Failed to generate the variant.';
  } finally {
    q.generatingType = null;
    renderActiveQuestion();
    if (q.variantGenError) {
      setTimeout(() => {
        if (q.variantGenError) {
          q.variantGenError = null;
          if (state.activeCardId === qid) renderActiveQuestion();
        }
      }, 5000);
    }
  }
}

// System prompts for regenerating just the choices/correct answer of an existing variant, without rewriting its question stem.
const REGENERATE_CHOICES_SYSTEM_PROMPTS = {
  clamp: `You are a quiz-writing assistant. You'll be given a fill-in-the-blank ("clamp") question stem — the blank is written as "___" — plus its target term/concept, optional source context, and the CURRENT choice list. Do NOT change or rewrite the question stem.

The current choice list is given one per line as either "[i] PRESERVE: <text>" (already written by a person — you must copy this into your output EXACTLY as given, unchanged) or "[i] BLANK" (empty — invent a new choice for this slot). Exactly one choice overall must be correct — the correct answer (the target term / correct definition subject, based on the given target term/context) may already be one of the PRESERVE choices, or you may need to place it into a BLANK slot; decide which from the given target term/context. Fill every other BLANK slot with a plausible but incorrect distractor, similar in length/style to the PRESERVE choices.

Rules (follow strictly):
1. Do not repeat the question stem in your output — only the choices.
2. Output EXACTLY the number of choices given, in the same index order — copy every PRESERVE choice back verbatim, only invent text for BLANK slots.
3. All choices must be unique; exactly one correct.
4. Base the correct answer on the given target term/context — never invent a fact not supported by it.
5. OUTPUT FORMAT: reply with ONLY a single JSON object, no markdown fences, no commentary:
{
  "choices": ["string", "string", "string", "string"],
  "correctAnswerIndex": 0
}
"correctAnswerIndex" is an integer indexing into "choices".`,

  rephrased: `You are a quiz-writing assistant. You'll be given a multiple-choice question stem plus its target term/concept, optional source context, and the CURRENT choice list. Do NOT change or rewrite the question stem.

The current choice list is given one per line as either "[i] PRESERVE: <text>" (already written by a person — you must copy this into your output EXACTLY as given, unchanged) or "[i] BLANK" (empty — invent a new choice for this slot). Exactly one choice overall must be correct — it may already be one of the PRESERVE choices, or you may need to place it into a BLANK slot; decide which from the given target term/context. Fill every other BLANK slot with a plausible but incorrect distractor, similar in length/style to the PRESERVE choices.

Rules (follow strictly):
1. Do not repeat the question stem in your output — only the choices.
2. Output EXACTLY the number of choices given, in the same index order — copy every PRESERVE choice back verbatim, only invent text for BLANK slots.
3. All choices must be unique; exactly one correct.
4. Base the correct answer on the given target term/context — never invent a fact not supported by it.
5. OUTPUT FORMAT: reply with ONLY a single JSON object, no markdown fences, no commentary:
{
  "choices": ["string", "string", "string", "string"],
  "correctAnswerIndex": 0
}
"correctAnswerIndex" is an integer indexing into "choices".`,

  true_false: `You are a quiz-writing assistant. You'll be given a true/false statement plus its target term/concept and optional source context. Do NOT change or rewrite the statement. Decide, strictly from the given target term/context, whether the statement is true or false.

OUTPUT FORMAT: reply with ONLY a single JSON object, no markdown fences, no commentary:
{
  "choices": ["True", "False"],
  "correctAnswerIndex": 0
}
"correctAnswerIndex" is an integer indexing into "choices" (0 for True, 1 for False).`,

  category: `You are a quiz-writing assistant. You'll be given a "Category Selection" ("select all that apply") question stem plus its target term/concept, optional source context, and the CURRENT choice list. Do NOT change or rewrite the question stem.

The current choice list is given one per line as either "[i] PRESERVE: <text>" (already written by a person — you must copy this into your output EXACTLY as given, unchanged) or "[i] BLANK" (empty — invent a new choice for this slot). At least 2 choices overall must be correct — some may already be among the PRESERVE choices, or you may need to place correct ones into BLANK slots; decide which from the given target term/context. Fill any remaining BLANK slots with plausible but incorrect distractors, similar in length/style to the PRESERVE choices.

Rules (follow strictly):
1. Do not repeat the question stem in your output — only the choices.
2. Output EXACTLY the number of choices given, in the same index order — copy every PRESERVE choice back verbatim, only invent text for BLANK slots.
3. All choices must be unique. At least 2 correct overall, at least 1 incorrect distractor when the context supports one.
4. Base the correct answers on the given target term/context — never invent a fact not supported by it. If the context enumerates sub-items under one umbrella concept (e.g. a "Threats to Databases" passage naming loss of integrity/availability/confidentiality), each sub-item is normally its own correct choice.
5. OUTPUT FORMAT: reply with ONLY a single JSON object, no markdown fences, no commentary:
{
  "choices": ["string", "string", "string", "string"],
  "correctAnswerIndices": [0, 1]
}
"correctAnswerIndices" is an array of integers indexing into "choices".`,
};

// Returns the indices of choices with empty/blank text.
function getEmptyChoiceIndices(variant) {
  return variant.choices.reduce((acc, c, i) => {
    if (!c || !c.trim()) acc.push(i);
    return acc;
  }, []);
}

// Regenerates choices (and correct answer(s)) for the given variant via AI, without touching its questionText.
async function regenerateChoicesForVariant(q, variant) {
  ensureProviderReady();
  if (!variant.questionText.trim()) {
    throw new Error('Fill in the question text first — there\'s nothing to base choices on yet.');
  }

  const systemPrompt = REGENERATE_CHOICES_SYSTEM_PROMPTS[variant.type] || REGENERATE_CHOICES_SYSTEM_PROMPTS.rephrased;
  const contextText = q.answerSnippet || q.sourceSnippet || '';
  // Preserve the variant's current choice count rather than resetting it back to a default.
  const choiceCount = variant.type === 'true_false' ? 2 : variant.choices.length;
  // Lists each current choice as PRESERVE (has text) or BLANK (empty, AI may fill it).
  const emptyIndices = getEmptyChoiceIndices(variant);
  const currentChoicesListing = variant.type === 'true_false' ? '' : `\nCurrent choices:\n${variant.choices.map((c, i) => emptyIndices.includes(i) ? `[${i}] BLANK` : `[${i}] PRESERVE: "${c}"`).join('\n')}`;
  const userPrompt = `Question stem (do not rewrite this): "${variant.questionText}"
Target term / correct answer hint: "${q.targetTerm || '(not given — infer the correct answer from the context below)'}"${contextText ? `\nSource context (use ONLY this for facts): """\n${contextText}\n"""` : ''}
${variant.type === 'true_false' ? '' : `\nProduce exactly ${choiceCount} choices (not more, not fewer).`}${currentChoicesListing}
Generate the choices now, and return only the JSON object.`;

  let rawText;
  try {
    rawText = await callAi(systemPrompt, userPrompt);
  } catch (err) {
    if (handleApiError(err, null)) {
      throw new Error('⚠ API Quota Exceeded or Rate Limited. You have run out of API usage or are making requests too quickly.');
    }
    throw err;
  }

  let parsed;
  try { parsed = safeParseAIJson(rawText); } catch (e) { parsed = null; }

  const expectedChoiceCount = choiceCount;
  if (!parsed || !Array.isArray(parsed.choices) || parsed.choices.length !== expectedChoiceCount) {
    throw new Error('The AI response was not a usable set of choices. Try again.');
  }
  let choices = parsed.choices.map(c => cleanExtractedText(String(c ?? '')));
  if (choices.some(c => !c)) throw new Error('The AI response was not a usable set of choices. Try again.');
  // Force the original text back into every non-blank index so an existing choice can't be altered by the AI.
  choices = choices.map((c, i) => (emptyIndices.includes(i) ? c : variant.choices[i]));

  if (variant.type === 'category') {
    if (!Array.isArray(parsed.correctAnswerIndices) || parsed.correctAnswerIndices.length === 0) {
      throw new Error('The AI response was not a usable set of choices. Try again.');
    }
    const seen = new Set();
    for (const n of parsed.correctAnswerIndices) {
      const idx = Number(n);
      if (!Number.isInteger(idx) || idx < 0 || idx >= expectedChoiceCount) {
        throw new Error('The AI response was not a usable set of choices. Try again.');
      }
      seen.add(idx);
    }
    return { choices, correctAnswerIndices: Array.from(seen).sort((a, b) => a - b) };
  }

  const correctAnswerIndex = Number(parsed.correctAnswerIndex);
  if (!Number.isInteger(correctAnswerIndex) || correctAnswerIndex < 0 || correctAnswerIndex >= expectedChoiceCount) {
    throw new Error('The AI response was not a usable set of choices. Try again.');
  }
  return { choices, correctAnswerIndex };
}

async function handleRegenerateChoices(qid) {
  const q = state.questions.find(x => x.id === qid);
  if (!q || q.choicesBusy) return;
  const variant = q.variants[q.activeVariantIndex];
  if (!variant) return;

  // Skip the AI call entirely if there are no blank choice slots to fill.
  if (getEmptyChoiceIndices(variant).length === 0) {
    q.choicesError = 'All choices already have text — nothing to auto-fill.';
    renderActiveQuestion();
    setTimeout(() => {
      if (q.choicesError === 'All choices already have text — nothing to auto-fill.') {
        q.choicesError = null;
        if (state.activeCardId === qid) renderActiveQuestion();
      }
    }, 3500);
    return;
  }

  q.choicesBusy = true;
  q.choicesError = null;
  renderActiveQuestion();

  try {
    const result = await regenerateChoicesForVariant(q, variant);
    variant.choices = result.choices;
    if (variant.type === 'category') {
      variant.correctAnswerIndices = result.correctAnswerIndices;
    } else {
      variant.correctAnswerIndex = result.correctAnswerIndex;
    }
  } catch (err) {
    console.error(err);
    q.choicesError = err.message || 'Failed to regenerate choices.';
  } finally {
    q.choicesBusy = false;
    renderActiveQuestion();
    if (q.choicesError) {
      setTimeout(() => {
        if (q.choicesError) {
          q.choicesError = null;
          if (state.activeCardId === qid) renderActiveQuestion();
        }
      }, 5000);
    }
  }
}

// Detects a quota-exhausted/rate-limited API error and reports it via statusElement or alert; returns true if handled.
function handleApiError(err, statusElement) {
  // Batch 7: connection-refused / model-not-loaded failures from a local or self-hosted endpoint are not quota problems — let their own message through.
  if (err && err.isLocalEndpointError) return false;
  const msg = (err.message || '').toLowerCase();
  const isQuota = msg.includes('quota') || msg.includes('insufficient_quota') || err.status === 429 || msg.includes('rate limit');

  if (isQuota) {
    const warning = '⚠ API Quota Exceeded or Rate Limited. You have run out of API usage or are making requests too quickly.';
    if (statusElement) {
      statusElement(warning, 'error');
    } else {
      console.error(warning);
      alert(warning);
    }
    return true;
  }
  return false;
}

export {
  isValidChoiceCount,
  normalizeVariant,
  normalizeClampVariant,
  parseClampVariantSet,
  generateSingleVariant,
  handleGenerateVariant,
  regenerateChoicesForVariant,
  handleRegenerateChoices,
  handleApiError,
};