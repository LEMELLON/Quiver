// --- Shared dependencies ---
import { state } from './core-state.js';

// Functions from other modules that these functions call:
import { generateSingleVariant } from './variant-generation.js';
import { collectTargetTerms } from './ai-prompt-builders.js';
import { generateQuestionsWithAI } from './ai-api-calls.js';
import { sortQuestionsByPage, updateQuestionCount } from './question-model.js';
import { renderTextVersion } from './layout-formatting.js';
import { renderQuestionNav, setActiveCard } from './editor-render.js';

// generates one variant of the given type for each question and makes it active; no-op for 'mixed'/'clamp'
async function applyPreferredQuestionType(questions, type) {
  if (!type || type === 'mixed' || type === 'clamp') return;
  for (const q of questions) {
    try {
      const variant = await generateSingleVariant(q, type);
      q.variants.push(variant);
      q.activeVariantIndex = q.variants.length - 1;
    } catch (err) {
      console.error(err);
    }
  }
}

// runs the 3-pass AI pipeline scoped to a page range and appends the results to state.questions
async function scanPageRange(from, to, questionType) {
  const rangePages = state.pages.filter(p => p.pageNumber >= from && p.pageNumber <= to);
  if (rangePages.length === 0) throw new Error('No pages in that range.');

  const seedTerms = collectTargetTerms(state.questions);
  const generated = await generateQuestionsWithAI(rangePages, seedTerms);
  await applyPreferredQuestionType(generated, questionType);

  state.questions = state.questions.concat(generated);
  sortQuestionsByPage();
  updateQuestionCount();
  renderTextVersion();
  renderQuestionNav();
  setActiveCard(generated[0].id);
  return generated;
}

export {
  applyPreferredQuestionType,
  scanPageRange,
};
