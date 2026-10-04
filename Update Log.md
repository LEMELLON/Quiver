# Update Log

## Snippet Pipeline Overhaul — Batch 1 (data model, classification, duplicates, export)

**Files changed:** `question-model.js`, `ai-api-calls.js` (`parseAiQuestions` only), `quiz-export.js` (`buildQuizObject` only). `ai-prompt-builders.js` untouched (per spec).

**What changed**
- `newQuestion()` now carries `questionSnippet`, `questionFound`, `answerPage: null`, `answerScope: 'inside'`, `sourceOccurrence/questionOccurrence/answerOccurrence: 0`.
- New exported helper `isContainedIn(child, parent)` (via `fuzzyIncludes`). Private helper `answerLocatableOnPage(q)` checks an `outside` answer against `answerPage` (default `sourcePage`) text of the question's own source; if that page text is unavailable it falls back to trusting `answerFound`.
- `computeDataClassification`: unclassified if any of source/question/answer is empty; verified only if all three `*Found !== false` AND question inside source AND (answer inside source for `inside`, or answer present on `answerPage` for `outside`); otherwise unverified.
- `computeDuplicateMap`: the "same source passage" branch now compares `questionSnippet` (same sourceId+sourcePage rule, same 20-char minimum, same auto-`extension` rule). Reason string kept as `'same source passage'` so existing UI text is unchanged. Same-target-term branch untouched.
- `parseAiQuestions`: AI `questionSnippet` stored in both `questionSnippet` and `sourceSnippet` (D2); sets `questionFound`, `answerScope: 'inside'`, `answerPage: null`, occurrence defaults. Answer validation unchanged (Batch 6 replaces it).
- `buildQuizObject`: exports `questionSnippet`, `answerPage` (null if unset), `answerScope`. `formatVersion` stays 2; `validateQuiz` unchanged and still passes.

**Verification done:** `node --check` on all three files; real `question-model.js` run against stubbed neighbours, 11 checks pass, including both Batch 1 acceptance bullets (shared source + different question snippets = not duplicate; same question snippet = flagged; export fields via defaults). **Not done:** browser run, and a live `parseAiQuestions` run (needs the DOM/module graph). First thing to do in the browser: import a PDF, confirm questions are created and `Export JSON` contains the three new keys.

**Interim quirks (expected, resolved by later batches)**
- Questions created by the old selection flow (`generateQuestionFromSnippet`) and by `handleScanField` have no `questionSnippet`, so they show **Unclassified** and can't trigger the "same source passage" duplicate flag. Fixed by Batches 2 and 4.
- Bulk-AI questions whose answer sits on the page but outside the question snippet show **Unverified** (scope `inside`, containment fails). Fixed by Batch 6's fallback chain.
- `generateQuestionFromSnippet`'s returned object lacks the new fields; export and classification tolerate that via defaults.

**`FILE_FUNCTION_MAP.md` edits to apply**
- `question-model.js` exports: add `isContainedIn`. Note: `computeDuplicateMap` keys on `questionSnippet`; classification is 3-slot. New dependencies: `highlighting.js` (`fuzzyIncludes`) and `snippet-question-generation.js` (`cleanExtractedText`) — function-body use only, so the extra import cycles are safe.
- `quiz-export.js`: note that export now includes `questionSnippet`, `answerPage`, `answerScope`.
- `ai-api-calls.js`: note `parseAiQuestions` sets `sourceSnippet === questionSnippet` plus the new fields.
