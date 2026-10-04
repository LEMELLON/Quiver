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

## Snippet Pipeline Overhaul — Batch 3 (highlight engine) — completion + chat fix

**State found:** `highlighting.js` already contained 3a–3d and the Batch 2 listener/HTML were in place, but `layout-formatting.js`'s `renderTextVersion()` still called the new three-slot ladder with the old two-slot shape (question drawn from `sourceSnippet`, no source pass, no parent context). Result: Pane 2 drew no question/answer marks and Sync Highlights reported everything missing.

**Files changed:** `layout-formatting.js` (`renderTextVersion` only), `highlighting.js` (one line block in `recheckHighlightsForQuestion`), `styles.css`, `editor-render.js` (`setActiveCard` only for this batch).

- `renderTextVersion()` (3e, D4): per-question `ctx` objects carry each resolved slot's range to its children. Draw order: source marks (longest first) → question marks (tier order) → answer marks. Results map is now `{ source, question, answer }` per qid, which `recheckHighlights()` already consumed.
- `recheckHighlightsForQuestion`: the non-shortcut path now unwraps all three of the question's slots before redrawing, so a stale child mark can't widen a freshly drawn parent.
- `styles.css` (3a): new `mark.source-highlight-source` (subtle outer wrapper, hover + active states, shares the inline/clone display rule); V-badge rules now exclude `[data-snippet-type="source"]`.
- `setActiveCard` (3f): scrolls to the source mark first, then question, then answer (an outside answer on an earlier page no longer pulls the view away). `locateSnippetInDoc` already works for `source` generically.

**Verified in a real browser (Chromium, stubbed neighbours, rendered DOM):** repeated-term case (answer lands in sentence 2; `answerOccurrence` 0/1 moves it), inside-scope answer not in source = no mark + Unverified, outside answer on page 1 with source/question on page 3 (marks on the right pages, Verified, per-question recheck leaves marks unchanged apart from the verify-tier attribute), nested source ⊃ question ⊃ answer with no empty shells and page text unchanged, two overlapping sources both fully located.

**Known quirks (not fixed):**
- Per-question recheck uses verify tier 2 for exact finds while the batch render uses tier 1, so `data-tier` flips 1↔2 on marks after a single-question recheck (pre-existing design).
- An inside answer selected in the source but *outside* the question snippet, whose text also occurs inside the question snippet, resolves to the question-range match first (ladder order). Rare.
- `mark` click handler in `main.js` was not changed (innermost mark wins, which is correct for nested marks); not exercised in the browser here.

## Snippet Pipeline Overhaul — Batch 4 (editor UI, scanning, editing, auto-sync off)

**Files changed:** `editor-render.js`, `snippet-question-generation.js`, `question-model.js` (two transient fields), `shared-constants.js`, `highlighting.js` (see above). `online-quiz-maker.html` needed no change (all new UI is rendered by `activeEditorTemplate`).

- **Three snippet panels** (`snippetPanelTemplate`): Source (read-only), Question, Answer; each with Locate 🔍 and `data-action="scanField"` (`data-field-type="source|question|answer"`). Answer panel also has `➕ Answer outside source` (`scanAnswerOutside`). Badges: "Outside source · p.N" on outside answers; "⚠ Outside source" on any question/answer snippet that is not inside the source. Data-status tooltip updated.
- **`handleScanField`**: question/answer require the selection to be inside the source (DOM range check on the same page first, so the right occurrence is validated; `fuzzyIncludes` fallback if the Range is stale). Rejections set `scanError` (answer message suggests "Answer outside source") and change no state. Occurrence is computed against the right parent (answer → question range if the selection is inside it, else source). Source scan replaces the source, may move `sourcePage`/`sourceId`, and applies D5: invalid children are cleared with a visible notice; an outside answer with no explicit page is pinned to the old source page, and is cleared only if the source file itself changed.
- **`handleScanAnswerOutside`**: selection must be from the same source file; sets `answerScope: 'outside'`, `answerPage`, occurrence relative to that page; never touches `sourcePage`.
- **Editable snippets** (`startSnippetEdit` / `saveSnippetEdit` / `cancelSnippetEdit`): Edit → textarea → Save/Cancel on Question and Answer only. Save validates (question and inside-answer inside the source; outside-answer present on `answerPage`); invalid = old value kept, editor stays open with the message. Valid = store, occurrence 0, found flag, forced single-question recheck. Empty clears. Draft text lives in transient `q.editDraft`/`q.editingField`.
- **Auto-sync off (D10):** `AUTO_SYNC_ENABLED = false` in `shared-constants.js`. `onSnippetRelevantEdit(qid)` replaces every `scheduleAutoSync` call site in `editor-render.js`: always a debounced (900 ms, same as before, so the editor isn't re-rendered mid-tab) `recheckHighlightsForQuestion`; `scheduleAutoSync` only when the flag is true. Sync footer hidden when false (dormant `snippetBusy`/`snippetSyncPending` rendering kept). `scheduleAutoSync`, `runAutoSync`, `autoSyncTimers` untouched.
- **Dormant resync kept connectable:** `RESYNC_SNIPPET_SYSTEM_PROMPT`, `resyncSnippetsForQuestion`, `handleResyncSnippets` now treat the source snippet as authoritative and fixed; the AI returns `questionSnippet` + `answerSnippet` (substrings of the source); outside answers are left alone. DIAGNOSTIC logs dropped in those two functions only.

**Verified in a real browser (Chromium, stubbed neighbours):** 39 checks — scans (rejected from another page with no state change; accepted inside source; answer occurrence; outside answer stored/marked on page 2/Verified; normal answer scan resets scope; source replacement clears invalid children with notice and removes their marks), edits (invalid refused and editor stays open; valid redraws; empty clears → Unclassified), flag off = no network. Real `activeEditorTemplate` rendered and clicked through: 3 panels, 3 scan buttons, outside button, no Edit on Source, no sync footer, invalid edit message, cancel, outside badge. Flag on: edit → resync prompt contains the source only, question/answer updated, source unchanged, no throw.

**Not verified:** the full app (only a subset of modules was available; the rest were stubbed), real Gemini/OpenAI calls, the real Pane 3 / `renderDocPage` interaction, touch devices.

**Interim quirks:** `generateQuestionFromSnippet` and the unused `applyPreferredQuestionType` import remain until Batch 10. The "Locate" on a source/question/answer snippet uses whatever marks exist; an outside answer relocated by the ladder to a different page than `answerPage` isn't reflected in the badge.

**`FILE_FUNCTION_MAP.md`:** see the "Snippet overhaul — Batch 3/4 additions" section appended to that file.

## Question-snippet fallback + short-selection highlighting — Batches 1-4

**Files changed:** `selection-toolbar.js`, `shared-constants.js`, `highlighting.js` (`findMatchesInIndex` + three private helpers), `field-sync.js`, `editor-render.js` (`fieldSyncRowInnerHtml`, one import), `styles.css` (`.field-sync-note`, CRLF kept), `FILE_FUNCTION_MAP.md`.

**Batch 1 — short selections reach the scan buttons.** `handleTextSelection` no longer bails out at 10 characters before `setLastDocSelection`. Any non-empty selection inside a Pane 2 page is captured for the scan buttons. The floating create button still needs `MIN_CREATE_SELECTION_LEN` (new, 11, in `shared-constants.js`); a shorter selection hides the toolbar and sets pending to `null`, so a stale longer selection can't feed the create button. Scan messages, `finishScan` clearing and `hideSelectionToolbar` unchanged.

**Batch 2 — whole-word matching.** `findMatchesInIndex` returns only whole-word hits when there is at least one (all three ladder levels), else the old substring hits. `AI` no longer lights up inside `maintain`/`said`; `cell` in `cellular` still highlights; `Rizal` in `Rizal's` and `well` in `well-known` count as whole words (apostrophe and hyphen are boundaries; this resolves the handoff's contradictory apostrophe wording in favour of the possessive case). CJK edges never need a boundary.

**Batch 3 — question text falls back to the verbatim snippet.** `deriveQuestionInfo` returns `{ text, mode, reason, occurrences }`: `blanked` when the answer is inside the question snippet, else `verbatim` (the normalized question snippet) for no answer / answer outside / answer not in the question snippet; `null` only with no question snippet. New exports `getQuestionDerivationMode`, `getVerbatimReason`. `getUnderivableReason(q, 'question')` is now only "there is no question snippet". Baseline model, `reconcileFieldSync`, `applyFieldSync`, `getFieldSyncState` untouched; scanning the answer afterwards auto-follows verbatim -> blanked, a hand-edited stem is never overwritten. Verbatim writes are logged to the console.

**Batch 4 — editor UI.** Muted `.field-sync-note` under the question text in verbatim mode ("Using the question snippet as written — the answer isn't blanked because ..."), shown only when synced, verbatim and the field equals the derived text. "Can't derive" remains for a missing question snippet only. Sync button title equals the value it writes. The two-button `mousedown` guard is unchanged.

**Verified:** `field-sync.js` real module under Node with stubbed `cleanExtractedText`/`normalizeWhitespace`: 26 checks (every acceptance bullet of Batch 3, incl. the screenshot case). `findMatchesInIndex` (real source, extracted) under Node: 17 checks. `selection-toolbar.js` + `dom-refs.js` real, in headless Chromium with real mouse / selectionchange / double-click events and stubbed `core-state.js`, `doc-pane-navigation.js`: 15 checks. `fieldSyncRowInnerHtml` (real source, extracted) against the real `field-sync.js`: 10 checks.

**Not verified / known issues (recorded, not fixed):** the full app (real PDF/PPTX, live Gemini/OpenAI/Qwen bulk import, Sync Highlights / Format Layout redraws, mobile long-press, duplicate / Remove Duplicates, multi-source switching, a run with `AUTO_SYNC_ENABLED = true`). `quiz-export.js` was not uploaded, so the `syncBaseline`-not-exported check was not re-run (nothing in this change touches `buildQuizObject`; the earlier Batch 5 check stands). `snippet-question-generation.js` needed no change (`selectionGenerateBtn` already returns on a null pending selection). The grep for selection-length gates finds only `highlighting.js` `bestSentenceInBody`'s sentence filter, which is unrelated. Blanking `targetTerm` in the question snippet when there is no answer snippet was left out of scope (G4).

