# Handoff: Strip Verbose Comments Out of the Codebase

## Objective

Every module in this codebase carries extremely heavy narrative comments
(multi-paragraph rationale blocks, "verbatim from source, lines X-Y"
provenance markers, per-decision NOTE/FLAG/UPDATE blocks referencing
external prompt docs). This is burning a large amount of context on every
agent that has to read these files.

**Change from the previous approach: no archive files anymore.** These
comments are not being preserved anywhere — they are simply deleted. The
only thing that stays behind is a genuine function/const description,
compressed to one line, under 50 words.

**Hard rule: this is a comment-only refactor. Zero logic changes.** Every
line of actual code (imports, exports, function bodies, variable names,
control flow) must be byte-identical before and after. If you think a
piece of code looks wrong while doing this pass, leave a short note in
`FILE_FUNCTION_MAP.md` for that file instead — do not fix it here. Use
`FILE_FUNCTION_MAP.md` as your table of contents/checklist — work through
it file by file, and update that map's status column as you go.

## Session workflow (this pass is done across many separate sessions)

This task is worked in short bursts, not one sitting — read this section
first, every time, before touching any file.

1. **Start of session:** the user sends this handoff plus
   `FILE_FUNCTION_MAP.md`. Read the **Extraction status tracker** below
   first — it, not memory, is the source of truth for what's already
   done. Resume from the first file marked ⬜/🔄; don't restart finished
   files.
2. **Do the work:** for each file you take on this session, follow the
   *Per-file workflow checklist* further down — delete every update-crumb
   comment and compress every remaining function/const description down
   to a single line under 50 words.
3. **Before ending the session:** update the tracker below — flip each
   file you finished this session from ⬜ (not started) or 🔄
   (in progress) to ✅ (done), and leave a one-line note if you stopped
   a file partway through (🔄) so the next session knows exactly where
   to pick up. Also update `FILE_FUNCTION_MAP.md`'s status column per
   step 4 of the checklist, if applicable.
4. **End of session:** hand back this updated handoff file, together
   with every code file touched this session. The next session starts
   fresh from what you return — nothing is assumed to carry over except
   what's written down.

### Extraction status tracker

Legend: ⬜ not started · 🔄 in progress (see note) · ✅ done

| File | Status | Note |
|---|---|---|
| core-state.js | ⬜ | |
| dom-refs.js | ⬜ | |
| shared-constants.js | ⬜ | |
| classification-meta.js | ⬜ | |
| status-helpers.js | ⬜ | |
| config.js | ⬜ | |
| seed-api-key.js | ⬜ | |
| doc-extraction.js | ⬜ | |
| pdf-render.js | ⬜ | |
| pptx-render.js | ⬜ | not yet reviewed |
| highlighting.js | ⬜ | not yet reviewed |
| doc-pane-navigation.js | ✅ | |
| layout-formatting.js | ⬜ | not yet reviewed |
| editor-render.js | ⬜ | not yet reviewed |
| text-normalize.js | ⬜ | |
| slide-panel-mirror.js | ⬜ | dead-code question resolved (no live caller found in main.js or doc-pane-navigation.js) — delete the file per special case below |
| gemini-classifier.js | ⬜ | |
| ai-credentials-and-models.js | ⬜ | |
| ai-api-calls.js | ⬜ | not yet reviewed |
| ai-prompt-builders.js | ⬜ | not yet reviewed |
| variant-generation.js | ⬜ | not yet reviewed |
| snippet-question-generation.js | ⬜ | not yet reviewed |
| question-model.js | ⬜ | not yet reviewed |
| selection-toolbar.js | ⬜ | |
| batch-scan.js | ⬜ | |
| quiz-export.js | ⬜ | |
| main.js | ✅ | |
| online-quiz-maker.html | ⬜ | not yet reviewed |
| styles.css | ⬜ | not yet reviewed |

---

## What to keep vs. what to delete

**Keep (compress to one line, under 50 words):**
- A description of what a function/const does, if genuinely useful to
  read at a glance (e.g. `// renders one PDF page to a PNG data URL`).
- A short inline comment that clarifies a genuinely non-obvious line of
  logic right where it happens — also compressed to one line if longer.

**Delete outright — no replacement, no pointer, nothing kept:**
- File-header blocks explaining why a module exists, its extraction
  history, or its relationship to other modules.
- Every `// Verbatim from source, lines X-Y` marker.
- `NOTE (structural, not a logic change): ...` blocks.
- `FLAGGED (not moved here...)` blocks.
- `UPDATE 2A / UPDATE 2B / UPDATE N (new feature work...)` rationale blocks.
- Named "DECISION" blocks (e.g. `SIZING DECISION`, `DEBOUNCE DECISION`,
  `PPTX TIER DECISION`, `WRONG-SOURCE-CONTAMINATION GUARD`) — anything
  explaining *why* a constant/approach was chosen over an alternative.
- Any comment referencing an external prompt/handoff doc by filename
  (e.g. `UI_UPGRADES_HANDOFF_PROMPT.md`, `GEMINI_MODEL_FIX_...md`).
- Any other "update crumb" — a comment that narrates the history of a
  change rather than describing what the code currently does.

If a block mixes a genuine function description with update-crumb
narrative, keep only the description (one line, under 50 words) and
delete the rest — don't try to summarize the crumb, just cut it.

## Special case: slide-panel-mirror.js

Before doing a comment pass on this file, resolve whether it's dead
code — see the flag already raised in `FILE_FUNCTION_MAP.md`. It imports
four DOM refs (`slidePanelMirrorEl/Img/Empty/Fallback`) that don't exist
in the current `dom-refs.js`, and both `core-state.js` and `dom-refs.js`
explicitly say this feature was reverted/deleted. Check `main.js` and
`doc-pane-navigation.js` for any live `import` of this file or call to
`updateSlidePanelMirror()`:
- **If no live caller exists:** delete the whole file. Note the deletion
  and why in a short line in `FILE_FUNCTION_MAP.md` (this is the only
  place that history is kept now — there's no archive file for it).
- **If a live caller does exist** (meaning the "already deleted" claim
  in the other files is itself stale/wrong): flag that contradiction
  loudly in `FILE_FUNCTION_MAP.md`, then treat it as a normal file for
  this pass.

## Per-file workflow checklist

For each file, in order:

1. Read the file. Identify every comment block.
2. For each block: if it's an update crumb (per the delete list above),
   delete it outright. If it's a genuine function/const description,
   compress it to one line, under 50 words, and leave it directly above
   the code it describes.
3. Confirm the diff for that file touches **only comment lines** — no
   added/removed/reordered code, no changed whitespace inside code
   lines, no changed string literals. If you're not sure a line is "just
   a comment," leave it in place rather than guess.
4. Update that file's row/entry in `FILE_FUNCTION_MAP.md` if this is
   also the first time its content has actually been read (flip
   ⏳ pending → ✅ confirmed, fill in the real exports/deps).
5. Flip this file's row in the **Extraction status tracker** above to
   ✅ (or 🔄 with a note, if you stopped partway through). Then move to
   the next file, or — if the session is ending — hand back this
   handoff plus the touched code files per the *Session workflow*
   section above.

## Out of scope for this pass

- Fixing the `slide-panel-mirror.js` import mismatch (beyond deciding
  delete-vs-keep, per the special case above) — that's a code fix, not
  a comment edit.
- Fixing the known Pane-3-desync bug flagged in `batch-scan.js`.
- Re-verifying the hardcoded Gemini fallback model list in
  `gemini-classifier.js`.
- Any renaming, reformatting, or reorganizing of actual code.

If you notice any of the above while working, add a one-line note in
`FILE_FUNCTION_MAP.md` for that file instead of fixing it inline.
