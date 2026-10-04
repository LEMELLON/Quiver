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

## Snippet Pipeline Overhaul — Batch 2 (selection creates a blank question, no AI)

**Files changed:** `snippet-question-generation.js` (imports + `selectionGenerateBtn` listener only), `online-quiz-maker.html` (toolbar button label, `#selectionHint` text, toolbar select tooltip). `selection-toolbar.js` untouched (not needed).

**What changed**
- The toolbar button now builds a question locally: `newQuestion()`, then `sourcePage`/`sourceId` from the captured selection, `sourceSnippet = text`, `sourceFound = true`, and `variants = [newVariant(selectionQuestionType.value)]` (D3). Then push, `sortQuestionsByPage()`, `updateQuestionCount()`, `renderTextVersion()`, clear selection, `setActiveCard()`, hide toolbar. No API key check, no network, no `applyPreferredQuestionType`. The old busy/disabled/`finally` label-reset logic is gone.
- Status message: "Created Qxx from the selection — now scan its question and answer snippets." (Qxx is the per-source number.)
- Label `⚡ Generate Question from Selection` -> `➕ Create Question from Selection`; hint -> "Highlight text → create a question".
- `generateQuestionFromSnippet` and `SNIPPET_SYSTEM_PROMPT` left in place (Batch 10 removes). `applyPreferredQuestionType` import is now unused here; Batch 10 cleans it up. `tier` stays 1, `aiUnchecked` stays false.

**Verification done:** `node --check`; real `question-model.js` + real new listener with stubbed neighbours, 12 checks pass (no key, `fetch` stubbed to throw and never called, correct fields, blank variant of the chosen type, active card, one Pane 2 redraw, selection cleared/toolbar hidden, status text); grep of the output HTML confirms the new button text, the hint, and no leftover old wording. **Not done:** a click in a real browser. Until Batch 3, the new source passage is drawn by the existing `renderTextVersion()` as an ordinary tier-colored "question" mark; this is expected.

**Interim quirks:** the new question shows **Unclassified** until Question/Answer snippets exist (Batch 4 adds the scan buttons); the old "Scan question" button still writes into `sourceSnippet` and will overwrite the selection until Batch 4 rewires it.

**FLAG (found, not fixed - out of scope):** `online-quiz-maker.html` contains the OLD Quiz Code modal. Three ids that `dom-refs.js` reads - `secretKeyRow`, `combineKeyToggle`, `downloadCodeBtn` - are not in it; they exist only in the standalone `quizCodeModal.html`, which looks like an unmerged update. `quiz-export.js` null-guards these so nothing crashes, but the combine-key toggle and "Download .txt" button never appear. Fix = replace the modal block in the HTML with `quizCodeModal.html`'s contents. Say the word and I'll do it as a separate small change.

**`FILE_FUNCTION_MAP.md` edits to apply:** `snippet-question-generation.js` - new dependency on `question-model.js` (`newQuestion`, `newVariant`); note `selectionGenerateBtn` listener is now AI-free; `generateQuestionFromSnippet` is dead code pending Batch 10.
