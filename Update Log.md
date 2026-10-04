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


## Mini Quizzes in the Offline Quiz Taker — Batch 1 (data layer + session scope, no UI)

**Files changed:** `offline-quiz-taker.html` only (script section). Maker, importer, quiz file / Quiz Code format, integrity hash, `normalizeQuizData`, `recordAnswer`, `getLessonStats`, `getUnitedStats` untouched.

**What changed**
- New state: `selectedMiniKeys` (Set of `lessonId + '::' + miniId`) and `expandedMiniLessons` (Batch 2). `goToLessonsHub` resets `selectedMiniKeys`.
- New data layer, placed just above the stats modal code: `MINI_PREFIX = 'quizTaker.mini.'`, `MAX_MINI_PER_LESSON = 30`, `getLessonQuestions`, `getMiniScopeKey` (M3, djb2 `shortHash`), `miniKey` / `parseMiniKey`, `loadMiniQuizzes` (M4 reconcile, never throws, adds `missingCount`), `getMiniQuiz`, `getMiniQuestions` (file order, same objects as `quizData.questions` so `lessonId` and `id` are untouched), `createMiniQuiz` / `updateMiniQuiz` / `deleteMiniQuiz` (return `{ ok, error?, mini?, persisted? }`, no alert), `validateMiniInput`, `describeMiniSelection`, name helpers (M10), `isMiniStoragePersistent`.
- Storage: `localStorage['quizTaker.mini.' + scopeKey] = { lessonId, quizzes: [{ id, name, questionIds, createdAt, updatedAt }] }`. Reads use `safeGetJSON`. Writes use a direct try/catch (the existing `safeSetJSON` hides failure and Batch 4 needs to know). If a write fails, an in-memory copy keeps the session working and `isMiniStoragePersistent()` turns false.
- `getSelectedQuestions()`: nothing selected = whole quiz as before; otherwise the union of selected lessons and selected mini quizzes, de-duplicated by question object, returned in file order. New helper `getSelectedUnitCount()` (lessons + mini quizzes); the Kahoot shuffle rule is now "more than one unit".
- `goToModeSelect()` text: lessons only is word-for-word as before. Mini quizzes involved: `N questions from X mini quiz(zes)` or `N questions from X lesson(s) and Y mini quiz(zes)`.

**Decisions as built**
- M4: a save only rewrites the list for that lesson. Mini quizzes you did not touch are written back exactly as stored, so ids missing from the current file are not lost for them (they can return after a re-import). The mini quiz being edited is stored cleaned.
- Blank name on create = default name `Mini quiz N · Q{a}-{b}` or `Mini quiz N · Custom`. Names are trimmed, whitespace-collapsed, capped at 60 characters, and made unique per lesson with ` (2)`, ` (3)`.
- Lesson + one of its own mini quizzes selected together counts as 2 units, so Kahoot shuffles (follows the "more than one unit" rule literally; the question set is identical to the lesson).

**Verified (real functions in headless Chromium, test-only copy with a hook; the delivered file has no hook):** 26 checks. 5-id mini from a 20-question lesson returns exactly those 5 in file order with the original lessonId; reload returns the same quiz; removing 2 ids leaves 3 with no throw; removing all 5 keeps it listed with 0 matching; loading only reconciles, it never erases stored ids; two different legacy files get different scope keys and do not see each other's mini quizzes; nothing selected = full quiz; lesson + own mini = no duplicates; two minis from two lessons = union in file order; `getAllStatsLessonIds()` unchanged; 30th allowed, 31st refused with an error string; naming rules; update/delete; `localStorage` get/set/remove all throwing = no exception, works in memory, `isMiniStoragePersistent()` false.

**Known issue (recorded, not fixed):** membership is by question id, so a question without an `id` (possible in old flat files) cannot be in a mini quiz (creating one with no matching ids is refused with "Pick at least one question."). Those questions also record no stats today (`recordAnswer` skips a missing id), which is pre-existing. Batch 3's editor should say so instead of showing an empty checklist.

## Mini Quizzes in the Offline Quiz Taker — Batch 2 (hub UI and playing)

**Files changed:** `offline-quiz-taker.html` only (CSS, `renderLessonsHub`, handlers, one new stats function).

**What changed**
- Every lesson card has a full-width **✂ Mini quizzes** button (`data-action="mini-edit"`, 40px high). It is disabled on an empty lesson. It calls `openMiniEditor(lessonId, null)`.
- `openMiniEditor` is a PLACEHOLDER: it shows a one-line message in the hub's existing `#lessonsError` paragraph naming the lesson (or the mini quiz when editing). Batch 3 replaces its body.
- A lesson with at least one mini quiz gets a `.mini-list` inside its card: toggle `▸ N mini quizzes` (adds `· M selected` when some are ticked), collapsed by default. Open/closed state is `expandedMiniLessons` (in memory only; kept across re-renders and Quit, forgotten when a different file is loaded). Opening and closing does not re-render, so focus stays on the toggle.
- Each row: checkbox (`mini-select`), name, `N questions`, ▶ Play (`mini-play`), 📊 (`mini-stats`), ✎ (`mini-row-edit`, calls `openMiniEditor(lessonId, miniId)`), 🗑 (`mini-delete`, confirm). All new tap targets are at least 40x40. Every handler stops propagation and the card click handler also ignores anything inside `.mini-list`, so clicking a mini row never toggles the lesson.
- A mini quiz with 0 matching questions shows muted with `⚠ 0 questions match this file`; Play, checkbox and Stats are disabled; Edit and Delete work.
- Mini Play: `selectedLessonIds = new Set(); selectedMiniKeys = new Set([key]); startSessionSetup()`. Lesson Play also clears `selectedMiniKeys`. Select All stays lessons-only and clears mini selections. Start Session is enabled when either set is non-empty. Back from Mode Select keeps both selections. Selected mini keys that no longer exist or have 0 matching questions are dropped at render time.
- Mini Stats (`showMiniStatsModal`): the lesson's stats filtered to the mini quiz's questions, in the existing stats modal. Title `Lesson name · Mini quiz name`; the subtitle says the numbers are part of the lesson's stats. No stats keys are created for mini quizzes, and no reset is offered (M9).
- New `escapeAttr` (built on `escapeHTML`, also escapes quotes) for attribute values. Mini names are escaped everywhere they reach `innerHTML`; the existing unescaped `lesson.name` in `renderLessonsHub` was left alone as instructed.
- Lesson Reset is unchanged: it clears stats only and mini quizzes remain.

**Verified (rendered DOM, real clicks, headless Chromium):** 71 checks. A lesson with no mini quizzes renders card HTML identical to the original except for the new ✂ button (diffed against the untouched file); ✂ present on every card and disabled on the empty one; clicking text or blank areas in a mini row never toggles the lesson, while clicking the lesson itself still does; selecting a mini and pressing Start lands on Mode Select with `5 questions from 1 mini quiz`; lesson + mini = `13 questions from 1 lesson and 1 mini quiz`; one mini plays Exam level 1 and level 3 (only its 5 questions, then Results), Kahoot (5, file order) and Flashcard (3); playing a mini of 5 in Exam gave exactly +5 `timesSeen` in the lesson's blob, no new `quizTaker.stats.*` key, All-Time +5, lesson Stats modal and mini Stats modal both showing the 5, the other mini showing 0; Quit mid-session returns to the hub with selections cleared; Reset keeps the mini quizzes; Delete removes the row and its selection; whole-lesson Play and Select All text and Kahoot order are unchanged while mini quizzes exist; mini names with markup and quotes are shown as text and stay intact in `aria-label`; 360px and 320px have no horizontal page scroll and nothing spills outside the card; with storage fully blocked the hub renders, ✂ works and an in-memory mini quiz survives a re-render, with no uncaught errors.

**Not verified:** a real phone (only Chromium viewport emulation), a real exported Maker file or Quiz Code (fixtures were hand-built v2 and legacy flat files), and Flashcard and Kahoot played through to the Results screen from a mini quiz (they were started and quit, not finished). `FILE_FUNCTION_MAP.md` was not uploaded, so the taker-section check is still open for Batch 5.

**Known quirks (recorded, not fixed)**
- While a lesson is selected, its card keeps the existing hover/selected styling over the mini list too.
- The two-unit Kahoot shuffle also applies to "lesson + its own mini quiz" (same question set, shuffled), see Batch 1.
