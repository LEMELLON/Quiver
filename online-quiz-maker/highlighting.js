// highlighting.js
// Extracted verbatim from online-quiz-maker.html, source lines 2053-2821,
// plus the recheckHighlightsBtn event-wiring line that sits immediately
// after recheckHighlights() at source line 2703 (moved with its handler,
// per the "move with handler" event-wiring strategy used throughout this
// modularization — see MODULARIZATION_SCHEMA.txt).
// Function/const bodies are UNCHANGED from source — only import/export
// wrapper lines were added.

// --- Shared dependencies ---
import { state, getDuplicateMap } from './core-state.js';
import { docTextContainer, recheckHighlightsBtn } from './dom-refs.js';

// NOTE (structural, not a logic change): TIER_META was originally declared
// inline near question-model.js's section of the source but is read here
// too (highlightSnippetInContainer). See the same NOTE in question-model.js
// and editor-render.js — this module imports it from the shared
// classification-meta.js instead of duplicating the object.
import { TIER_META } from './classification-meta.js';

// normalizeWhitespace/stripPunctuationForMatch/stripListConjunctionsForMatch
// and SNIPPET_PUNCTUATION_RE are declared in text-normalize.js (see that
// module's own header note on SNIPPET_PUNCTUATION_RE being exported from
// there specifically because this module also uses it directly).
import {
  normalizeWhitespace,
  stripPunctuationForMatch,
  stripListConjunctionsForMatch,
  SNIPPET_PUNCTUATION_RE,
} from './text-normalize.js';

import { setSelectionGenStatus } from './status-helpers.js';

// Functions from other modules that these functions call:
import { renderQuestionNav, renderActiveQuestion } from './editor-render.js';
import { cleanExtractedText } from './snippet-question-generation.js';
// DUPLICATE_MARK_RESYNC_STRIP_FIX_PROMPT_V2.md: recheckHighlights() below
// now does a full rebuild by calling renderTextVersion() directly instead
// of running its own incremental own-page/fuzzy/term-only escalation —
// see that function's header comment for why. That makes this a 2-file
// import cycle: layout-formatting.js already imports several functions
// FROM this module (highlightSnippetInContainer, dedupeMarks,
// logAllHighlights, locateAndHighlightSnippet, markQidList, and
// recheckHighlights itself), and now this module imports back from it.
// Safe for the same reason noted on layout-formatting.js's own
// cross-module import of computeDuplicateMap from question-model.js
// (itself part of a cycle through this file): renderTextVersion() is only
// ever invoked from inside recheckHighlights()'s own function body, never
// at top-level module-evaluation time, so both modules have already
// finished evaluating by the time it actually runs.
import { renderTextVersion } from './layout-formatting.js';

// =====================================================================
// HIGHLIGHT_DUPLICATE_SHARED_MARK_FIX_PROMPT.md — multi-qid mark helpers.
//
// A <mark>'s data-qid used to always hold exactly one question id. It can
// now legitimately hold SEVERAL, space-separated (e.g. "q_3 q_7"), when
// two duplicate-flagged questions share the same source-passage highlight
// instead of one nesting inside (and visually hiding) the other — see
// highlightSnippetInContainer's type==='question' duplicate-sharing branch
// below. `~=` is the CSS attribute "word match" selector, so
// `mark[data-qid~="q_7"]` still finds a shared mark the same way
// `mark[data-qid="q_7"]` found a single-id one — every selector-style
// data-qid lookup in this codebase was updated from `=` to `~=`
// accordingly. Anywhere a mark's qid was compared with plain JS (e.g.
// `m.dataset.qid === someId`) must use markHasQid/markQidList instead,
// since that raw comparison silently returns false for a shared mark (no
// single id ever equals "q_3 q_7").
// =====================================================================
// Shared body for the several `document.querySelectorAll('mark[data-qid]')
// .forEach(...)` active/unchecked-highlight sync loops in this file (and
// the equivalent ones in editor-render.js / layout-formatting.js — each of
// those keeps its own copy since importing this one specifically would add
// nothing but an extra cross-file hop for a five-line loop body). Handles
// the multi-qid case: a shared mark's active-highlight lights up if `id`
// is ANY of its qids, and its unchecked-highlight shows if ANY of its
// qids' questions still needs a first look and isn't itself
// duplicate-suppressed (SUPPRESS_UNCHECKED_INDICATOR_FOR_DUPLICATES_PROMPT.md).
function syncMarkActiveAndUncheckedState(activeCardId) {
  document.querySelectorAll('mark[data-qid]').forEach(m => {
    const ids = markQidList(m);
    m.classList.toggle('active-highlight', ids.includes(activeCardId));
    const showUnchecked = ids.some(mid => {
      const markQ = state.questions.find(x => x.id === mid);
      const markDup = markQ && getDuplicateMap().get(markQ.id);
      return !!(markQ && markQ.aiUnchecked && !markDup);
    });
    m.classList.toggle('unchecked-highlight', showUnchecked);
  });
}

function markQidList(el) {
  return ((el && el.dataset && el.dataset.qid) || '').split(/\s+/).filter(Boolean);
}
function markHasQid(el, qid) {
  return markQidList(el).includes(qid);
}

// True if qidA and qidB are flagged as duplicates of each other, checked
// in BOTH directions. computeDuplicateMap() (question-model.js) only
// records a match on the "b" (later/duplicate) side of the pair —
// `getDuplicateMap().get(b)?.matchId === a` — so checking only
// `getDuplicateMap().get(qidA)?.matchId === qidB` misses half of all real
// duplicate pairs depending on which id happens to be passed first (which
// isn't fixed — it depends on render order, per this fix's root-cause
// writeup).
function areDuplicateQids(qidA, qidB) {
  if (!qidA || !qidB || qidA === qidB) return false;
  const map = getDuplicateMap();
  return (map.get(qidA) || {}).matchId === qidB || (map.get(qidB) || {}).matchId === qidA;
}

// Removes a single <mark> element, moving its children back up into its
// parent in place — same shape as the loop body in unwrapMarksForQuestion,
// pulled out here since the duplicate-sharing logic below also needs to
// unwrap one specific mark element it already has a reference to (rather
// than re-querying by qid+type). Deliberately does NOT call
// parent.normalize() — this can run mid-way through building a Range for
// a NEW highlight, and normalize() merging adjacent text nodes could
// invalidate that Range's start/end node references. Safe here because we
// only ever move the mark's existing child nodes to a new parent, never
// split or remove the text nodes a live Range might be anchored to.
function unwrapMarkElement(mark) {
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
}

// Called per matched-group Range, before the normal widen/extract/insert
// path, ONLY for type === 'question'. Looks for an existing
// mark[data-snippet-type="question"] that overlaps `range` and is
// duplicate-related (via areDuplicateQids) to `qid`. Returns:
//   - { skip: true }      — an existing mark already fully covers this
//                            span; `qid` was folded into its data-qid
//                            list in place. Caller should draw NO new
//                            mark for this group.
//   - { extraIds: [...] } — `range` fully covers one or more existing
//                            (smaller) duplicate-related marks; each was
//                            unwrapped (not left nested) and its id(s)
//                            are returned so the caller's new mark can
//                            carry the merged list.
//   - null                — no clean containment either way (a partial
//                            overlap, or no duplicate-related mark
//                            overlaps at all). Caller proceeds exactly as
//                            before; mergeNestedDuplicateMarks below is
//                            the safety net for the partial-overlap case.
function tryShareDuplicateMark(container, range, qid) {
  const candidates = container.querySelectorAll('mark[data-snippet-type="question"]');
  const extraIds = [];
  for (const mark of candidates) {
    const ids = markQidList(mark);
    if (!ids.some(id => areDuplicateQids(id, qid))) continue;

    let markRange;
    try {
      markRange = document.createRange();
      markRange.selectNode(mark);
    } catch (e) {
      continue; // mark isn't a valid selectable node — skip it
    }

    // Overlap test, same logic as widenRangeToAvoidPartialMarks.
    const overlaps =
      range.compareBoundaryPoints(Range.START_TO_END, markRange) < 0 &&
      range.compareBoundaryPoints(Range.END_TO_START, markRange) > 0;
    if (!overlaps) continue;

    const markStartsBeforeOrAtRange = range.compareBoundaryPoints(Range.START_TO_START, markRange) >= 0;
    const markEndsAfterOrAtRange = range.compareBoundaryPoints(Range.END_TO_END, markRange) <= 0;
    const existingContainsNew = markStartsBeforeOrAtRange && markEndsAfterOrAtRange;

    if (existingContainsNew) {
      // The existing mark already covers (or exactly equals) the span we
      // were about to highlight — just add our qid to it, no new <mark>.
      if (!ids.includes(qid)) mark.dataset.qid = ids.concat(qid).join(' ');
      return { skip: true };
    }

    const rangeStartsBeforeOrAtMark = range.compareBoundaryPoints(Range.START_TO_START, markRange) <= 0;
    const rangeEndsAfterOrAtMark = range.compareBoundaryPoints(Range.END_TO_END, markRange) >= 0;
    const newContainsExisting = rangeStartsBeforeOrAtMark && rangeEndsAfterOrAtMark;

    if (newContainsExisting) {
      // Our new span fully swallows this existing (smaller) mark — unwrap
      // it now (rather than letting the normal extract/appendChild path
      // nest it) and carry its id(s) forward onto the new mark the caller
      // is about to create.
      extraIds.push(...ids);
      unwrapMarkElement(mark);
      continue; // keep scanning — in principle more than one small mark could be swallowed
    }
    // Partial overlap only (neither fully contains the other) — leave it
    // for the existing widen-to-fully-contain fallback below;
    // mergeNestedDuplicateMarks (called after the new mark is inserted)
    // catches this case instead of leaving it nested/hidden.
  }
  return extraIds.length ? { extraIds } : null;
}

// Safety net for the "partial overlap" case tryShareDuplicateMark leaves
// alone: after the normal widen/extract/insert path runs, a
// duplicate-related mark[data-snippet-type="question"] can still end up
// nested INSIDE the newly-inserted `outerMark` (widenRangeToAvoidPartialMarks
// expanded the range to fully contain it, then extractContents+appendChild
// nested it, exactly like the pre-fix behavior). Find any such nested
// mark, unwrap it, and fold its id(s) into outerMark's data-qid list
// instead of leaving it buried and invisible. Deliberately scoped to
// `[data-snippet-type="question"]` only — a type==='answer' mark nesting
// inside a type==='question' mark is normal/expected (see this file's
// header comment) and must never be touched here. A nested question-mark
// that ISN'T duplicate-related to anything in outerMark's list is also
// left alone — that's today's existing (non-duplicate) overlap behavior,
// unchanged per this fix's scope.
function mergeNestedDuplicateMarks(outerMark, qid) {
  const nested = Array.from(outerMark.querySelectorAll('mark[data-snippet-type="question"]'));
  if (!nested.length) return;
  let ids = markQidList(outerMark);
  nested.forEach(inner => {
    const innerIds = markQidList(inner);
    const related = innerIds.some(id => areDuplicateQids(id, qid) || ids.some(existingId => areDuplicateQids(id, existingId)));
    if (!related) return;
    unwrapMarkElement(inner);
    innerIds.forEach(id => { if (!ids.includes(id)) ids.push(id); });
  });
  outerMark.dataset.qid = ids.join(' ');
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 2053-2069
// ---------------------------------------------------------------------
function fuzzyIncludes(haystack, needle) {
  if (!needle) return false;
  const normHaystack = normalizeWhitespace(haystack);
  const normNeedle = normalizeWhitespace(needle);
  if (normHaystack.includes(normNeedle)) return true;

  // Fallback: retry with all punctuation stripped from both sides
  // before concluding the snippet genuinely isn't present.
  const strippedNeedle = stripPunctuationForMatch(normNeedle);
  if (strippedNeedle && stripPunctuationForMatch(normHaystack).includes(strippedNeedle)) return true;

  // Last fallback: a list-naming snippet vs. its bulleted rendering
  // (see stripListConjunctionsForMatch).
  const listNeedle = stripListConjunctionsForMatch(normNeedle);
  if (!listNeedle) return false;
  return stripListConjunctionsForMatch(normHaystack).includes(listNeedle);
}
// Block-level tags whose boundaries need a synthetic separating space in
// the normalized text — the DOM has zero real whitespace characters
// between e.g. two adjacent <li> text nodes even though the browser
// renders a line break there, so without this a snippet crossing that
// boundary can never match (whitespace-collapsing alone can't fix a
// *missing* character, only collapse existing ones).
// ---------------------------------------------------------------------
// Verbatim from source, lines 2076-2079
// ---------------------------------------------------------------------
const HIGHLIGHT_BLOCK_TAGS = new Set([
  'P', 'LI', 'DIV', 'TR', 'TD', 'TH', 'TABLE', 'UL', 'OL', 'BR',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE'
]);

// Nearest block-level ancestor of `node` (or `container` itself) — used
// to detect when the walker has crossed into a new visual "line".
// ---------------------------------------------------------------------
// Verbatim from source, lines 2083-2090
// ---------------------------------------------------------------------
function highlightBlockAncestorOf(node, container) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== container) {
    if (HIGHLIGHT_BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return container;
}

// Single-pass: walks every text node under `container`, producing a
// whitespace-collapsed string plus a parallel map where map[i] gives the
// exact {node, offset} that normalized[i] came from. Structural
// boundaries (li/li, p/p, etc.) get exactly one synthetic space
// inserted, anchored to the start of the following text node, merged
// cleanly with any real adjacent whitespace instead of doubling up.
// ---------------------------------------------------------------------
// Verbatim from source, lines 2098-2144
// ---------------------------------------------------------------------
function buildNormalizedContainerIndex(container) {
  const chars = [];
  const map = [];
  let lastWasSpace = true; // true at start so no leading space is emitted
  let lastBlock = null;
  let first = true;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue;
    if (!text) continue;

    const block = highlightBlockAncestorOf(node, container);
    if (!first && block !== lastBlock && !lastWasSpace) {
      chars.push(' ');
      map.push({ node, offset: 0, block });
      lastWasSpace = true;
    }
    lastBlock = block;
    first = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (/\s/.test(ch)) {
        if (!lastWasSpace) {
          chars.push(' ');
          map.push({ node, offset: i, block });
          lastWasSpace = true;
        }
        // else: extra whitespace collapses away, no map entry needed
      } else {
        chars.push(ch);
        map.push({ node, offset: i, block });
        lastWasSpace = false;
      }
    }
  }

  // Trim a single trailing synthetic/real space to keep offsets tidy.
  if (chars.length && chars[chars.length - 1] === ' ') {
    chars.pop();
    map.pop();
  }

  return { normalized: chars.join(''), map };
}

// Locates `snippet` inside `container`'s rendered text (spanning any
// number of inline elements, list items, and paragraphs) and wraps it in
// one or more <mark data-qid="…"> elements, without disturbing
// surrounding markup. `type` is either 'question' (source-context
// passage, colored by `tier` — see TIER_META) or 'answer' (always
// bright green, regardless of tier — the exact answer/target-term
// text) and selects which CSS class + dataset the wrapping <mark>(s)
// get. `tier` is ignored for type 'answer' and defaults to 1 for type
// 'question' if omitted or not 1/2/3.
//
// Matching always runs against a whitespace-normalized view of the
// container's text where structural boundaries (list items, paragraphs,
// <br>s, etc.) are given an explicit separating space — this is what
// lets a snippet that spans two bullet points or wraps across a line
// break still resolve to the correct live text-node ranges. Silently
// no-ops if the (normalized) snippet genuinely isn't present — a missed
// highlight should never break rendering.
//
// IMPORTANT: a match is never wrapped in a single <mark> that spans out
// of a block-level element (e.g. from inside one <li> into the next).
// Doing that would force one inline element to contain partial <li>/<p>
// content, which is invalid nesting and breaks list/paragraph layout.
// Instead, the matched span is split into one contiguous run per block
// segment, and each run gets its own <mark> (same qid/type/class) — the
// box-decoration-break: clone CSS on these classes then makes the
// separate marks render as one continuous highlighter stroke rather
// than looking like disconnected fragments.
//
// Because this walks and re-wraps live text nodes with the Range API
// (rather than doing string/regex replacement on HTML), it's safe to
// call twice in a row on the same container: highlighting the larger
// 'question' snippet first, then the (usually shorter) 'answer'
// snippet, correctly nests a green <mark> inside the tier-colored one
// when the answer text is a substring of the question snippet —
// without corrupting the surrounding markup either way.
// Strips SNIPPET_PUNCTUATION_RE characters from `str` while keeping a
// parallel map where map[i] is the index in the original `str` that
// stripped-string index i came from — lets a match found in the
// stripped string be translated back to real offsets in `str`.
// ---------------------------------------------------------------------
// Verbatim from source, lines 2185-2196
// ---------------------------------------------------------------------
function stripPunctuationKeepMap(str) {
  const chars = [];
  const map = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (SNIPPET_PUNCTUATION_RE.test(ch)) continue;
    chars.push(ch);
    map.push(i);
  }
  SNIPPET_PUNCTUATION_RE.lastIndex = 0; // reset since the regex has the /g flag
  return { stripped: chars.join(''), map };
}

// Same idea as stripPunctuationKeepMap, but also drops standalone
// "and"/"or" connector words (see stripListConjunctionsForMatch) —
// used as the last fallback pass in highlightSnippetInContainer for a
// snippet that names a list which got reformatted into bullets.
// ---------------------------------------------------------------------
// Verbatim from source, lines 2202-2226
// ---------------------------------------------------------------------
function stripListConjunctionsKeepMap(str) {
  const { stripped: punctStripped, map: punctMap } = stripPunctuationKeepMap(str);
  const chars = [];
  const map = [];
  const wordRe = /\b(?:and|or)\b/gi;
  const dropRanges = [];
  let m;
  while ((m = wordRe.exec(punctStripped))) dropRanges.push([m.index, m.index + m[0].length]);
  const isDropped = (i) => dropRanges.some(([s, e]) => i >= s && i < e);
  let lastWasSpace = true;
  for (let i = 0; i < punctStripped.length; i++) {
    if (isDropped(i)) continue;
    const ch = punctStripped[i];
    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;
      lastWasSpace = true;
    } else {
      lastWasSpace = false;
    }
    chars.push(ch);
    map.push(punctMap[i]);
  }
  while (chars.length && chars[chars.length - 1] === ' ') { chars.pop(); map.pop(); }
  return { stripped: chars.join(''), map };
}

// importanceTier (1-3, from q.tier — the AI's judgment of how essential
// this concept is) always drives the mark's background color.
// verifyTier (1-4, from recheckHighlights — how confidently this
// snippet was actually located just now) always drives the separate
// V1-V4 badge. The two are independent and never override each other.
// ---------------------------------------------------------------------
// Verbatim from source, lines 2233-2332
// ---------------------------------------------------------------------
function highlightSnippetInContainer(container, snippet, qid, type, importanceTier, verifyTier) {
  const normalizedSnippet = normalizeWhitespace(snippet);
  if (!normalizedSnippet) return;

  const resolvedImportance = importanceTier === 2 || importanceTier === 3 ? importanceTier : 1;
  const cssClass = type === 'answer'
    ? 'source-highlight-answer'
    : (TIER_META[resolvedImportance] || TIER_META[1]).highlightClass;
  const resolvedVerify = [1, 2, 3, 4].includes(verifyTier) ? verifyTier : 1;
  const { normalized, map } = buildNormalizedContainerIndex(container);
  if (!map.length) return;

  let idx = normalized.indexOf(normalizedSnippet);
  let matchLength = normalizedSnippet.length;

  if (idx === -1) {
    // Fallback: the AI's snippet sometimes differs from the rendered
    // source only in punctuation even though the wording matches
    // exactly. Strip punctuation from both sides and retry, then
    // translate the stripped-string match back to offsets in
    // `normalized` (via stripPunctuationKeepMap's map) so the rest of
    // this function — which walks `map` against `normalized` offsets —
    // doesn't need any further special-casing.
    const { stripped: strippedHaystack, map: strippedMap } = stripPunctuationKeepMap(normalized);
    const strippedNeedle = stripPunctuationForMatch(normalizedSnippet);
    if (strippedNeedle) {
      const strippedIdx = strippedHaystack.indexOf(strippedNeedle);
      if (strippedIdx !== -1) {
        idx = strippedMap[strippedIdx];
        const lastStrippedIdx = strippedIdx + strippedNeedle.length - 1;
        matchLength = strippedMap[lastStrippedIdx] - idx + 1;
      }
    }
  }

  if (idx === -1) {
    // Second fallback: a snippet that names a list ("A, B, and C") vs.
    // the same list reformatted as bullets ("A" / "B" / "C", each its
    // own <li>, connector words dropped entirely) — see
    // stripListConjunctionsKeepMap's comment.
    const { stripped: listHaystack, map: listMap } = stripListConjunctionsKeepMap(normalized);
    const listNeedle = stripListConjunctionsForMatch(normalizedSnippet);
    if (listNeedle) {
      const listIdx = listHaystack.indexOf(listNeedle);
      if (listIdx !== -1) {
        idx = listMap[listIdx];
        const lastListIdx = listIdx + listNeedle.length - 1;
        matchLength = listMap[lastListIdx] - idx + 1;
      }
    }
  }

  if (idx === -1) return; // genuinely not present, even after every fallback pass — no-op

  const endIdx = idx + matchLength - 1; // inclusive index of last matched char

  // Group the matched span into contiguous runs that share the same
  // block-level ancestor, in document order.
  const groups = [];
  for (let i = idx; i <= endIdx; i++) {
    const entry = map[i];
    const current = groups[groups.length - 1];
    if (current && current.block === entry.block) {
      current.endNode = entry.node;
      current.endOffset = entry.offset + 1;
    } else {
      groups.push({
        block: entry.block,
        startNode: entry.node,
        startOffset: entry.offset,
        endNode: entry.node,
        endOffset: entry.offset + 1,
      });
    }
  }

  groups.forEach(g => {
    try {
      const range = document.createRange();
      range.setStart(g.startNode, g.startOffset);
      range.setEnd(g.endNode, g.endOffset);

      // HIGHLIGHT_DUPLICATE_SHARED_MARK_FIX_PROMPT.md: for a 'question'
      // mark only, check whether this span overlaps an existing mark
      // belonging to a duplicate-flagged question BEFORE falling through
      // to the widen/extract/nest path below. Two duplicate questions
      // sharing/overlapping the same source passage is exactly the
      // situation that used to nest one mark inside the other (see this
      // function's header + the HIGHLIGHT_SYNC_DUPLICATE_MARK_FIX_PROMPT.md
      // comment a few lines down) — nesting is harmless for unrelated
      // overlaps (kept as-is below) but hides one of the two duplicates'
      // highlights entirely, since both marks' CSS classes paint an
      // opaque background-color on top of each other.
      let extraQidsForNewMark = [];
      if (type === 'question') {
        const shareResult = tryShareDuplicateMark(container, range, qid);
        if (shareResult && shareResult.skip) return; // folded into an existing mark — no new <mark> needed
        if (shareResult && shareResult.extraIds) extraQidsForNewMark = shareResult.extraIds;
      }

      // HIGHLIGHT_SYNC_DUPLICATE_MARK_FIX_PROMPT.md root-cause fix:
      // Range.extractContents() clones (rather than cleanly moves) any
      // element whose boundary falls PARTWAY inside the range being
      // extracted — cleanly outside or cleanly containing it is fine,
      // partial is not. Nesting one mark inside another is intentional
      // (see this function's header comment) and normally lands cleanly,
      // but any small mismatch — a whitespace-normalization edge case,
      // an off-by-one in buildNormalizedContainerIndex, a still-present
      // mark from a slot this redraw isn't touching — can leave this new
      // range's boundary landing mid-mark instead of exactly on its
      // edge. When that happens, the straddled mark gets cloned rather
      // than moved: the original stays in the document AND a duplicate
      // gets inserted, compounding on every redraw.
      // Fix: before extracting, widen the range so any <mark> it only
      // PARTIALLY overlaps becomes FULLY contained instead —
      // extractContents moves a fully-contained node whole, no cloning.
      // This can very slightly over-extend the newly drawn mark (by, at
      // most, however far the pre-existing mark stuck out past our own
      // matched boundary), but it can never duplicate or drop any
      // mark's content, and it needs no changes anywhere else — every
      // caller of highlightSnippetInContainer gets this for free.
      widenRangeToAvoidPartialMarks(container, range);
      const mark = document.createElement('mark');
      mark.className = cssClass;
      // Carries every id merged in via tryShareDuplicateMark's
      // "new span swallows an existing smaller mark" case, plus our own
      // qid — see the multi-qid mark helpers block near the top of this
      // file. For type 'answer' (or a 'question' mark with no merge),
      // extraQidsForNewMark is always empty and this is just [qid], same
      // as before.
      mark.dataset.qid = extraQidsForNewMark.length
        ? Array.from(new Set([...extraQidsForNewMark, qid])).join(' ')
        : qid;
      mark.dataset.snippetType = type === 'answer' ? 'answer' : 'question';
      mark.dataset.tier = String(resolvedVerify);
      if (resolvedVerify >= 3) mark.dataset.fuzzy = 'true';
      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);

      // Safety net for the partial-overlap case tryShareDuplicateMark
      // deliberately left alone (see its own comment): the widen step
      // just above may have expanded `range` to fully contain a
      // duplicate-related mark, which just got nested inside `mark` by
      // extractContents+appendChild above. Un-nest it now instead of
      // leaving it buried under mark's opaque background-color.
      if (type === 'question') mergeNestedDuplicateMarks(mark, qid);
    } catch (e) {
      // This segment spanned an incompatible boundary — skip it
      // gracefully (other segments still get highlighted), but log it
      // so a highlight that "should" be there but silently isn't has
      // a visible trail to debug from, instead of vanishing without a
      // trace.
      console.warn('highlightSnippetInContainer: a matched segment could not be wrapped and was skipped', { qid, type, snippet });
    }
  });
}

// Widens `range` in place so that no existing <mark data-qid> element
// under `container` is left PARTIALLY inside it — every mark ends up
// either fully inside or fully outside. Runs to a fixed point, since
// widening to enclose one mark can newly overlap another. See the call
// site above for why this exists.
function widenRangeToAvoidPartialMarks(container, range) {
  let changed = true;
  let guard = 0;
  while (changed && guard < 25) {
    changed = false;
    guard++;
    const marks = container.querySelectorAll('mark[data-qid]');
    for (const mark of marks) {
      if (mark === range.startContainer || mark === range.endContainer) continue;
      let markRange;
      try {
        markRange = document.createRange();
        markRange.selectNode(mark);
      } catch (e) {
        continue; // mark isn't a valid selectable node (shouldn't normally happen) — skip it
      }

      // Do range and markRange overlap at all? (range.start < mark.end)
      // AND (mark.start < range.end).
      const overlaps =
        range.compareBoundaryPoints(Range.START_TO_END, markRange) < 0 &&
        range.compareBoundaryPoints(Range.END_TO_START, markRange) > 0;
      if (!overlaps) continue;

      const markStartsBeforeRange = range.compareBoundaryPoints(Range.START_TO_START, markRange) > 0;
      const markEndsAfterRange = range.compareBoundaryPoints(Range.END_TO_END, markRange) < 0;
      if (!markStartsBeforeRange && !markEndsAfterRange) continue; // already fully contained — safe as-is

      try {
        if (markStartsBeforeRange) range.setStartBefore(mark);
        if (markEndsAfterRange) range.setEndAfter(mark);
        changed = true;
      } catch (e) {
        // Leave the range as-is if it can't be widened safely here —
        // an occasional clone is a smaller problem than corrupting the
        // range outright.
      }
    }
  }
}

// Removes every existing <mark> for this qid/type on a page and merges
// its text nodes back together, so a fresh highlightSnippetInContainer
// call starts from clean plain text instead of layering a second mark
// on top of (or around) a stale one. Used by recheckHighlights() right
// before it re-attempts a highlight that turned out missing/partial.
// ---------------------------------------------------------------------
// Verbatim from source, lines 2339-2348
// ---------------------------------------------------------------------
function unwrapMarksForQuestion(pageBody, qid, type) {
  const marks = pageBody.querySelectorAll(`mark[data-qid~="${qid}"][data-snippet-type="${type}"]`);
  marks.forEach(mark => {
    // HIGHLIGHT_DUPLICATE_SHARED_MARK_FIX_PROMPT.md point 3: a shared mark
    // (data-qid carrying more than one id — see the multi-qid mark helpers
    // near the top of this file) can't just be deleted because ONE of its
    // qids is being rechecked/re-highlighted — another duplicate-related
    // question may still be relying on this exact same <mark> for its own
    // highlight. Only drop `qid` from the list; leave the element (and the
    // other qid(s)) in place. Only actually unwrap/delete the <mark> when
    // removing `qid` would leave the list empty.
    const remainingIds = markQidList(mark).filter(id => id !== qid);
    if (remainingIds.length) {
      mark.dataset.qid = remainingIds.join(' ');
      return;
    }
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  });
  if (marks.length) pageBody.normalize();
}

// HIGHLIGHT_SYNC_DUPLICATE_MARK_FIX_PROMPT.md — cheap, conservative
// backstop. widenRangeToAvoidPartialMarks (in highlightSnippetInContainer)
// is the actual root-cause fix and should mean this rarely finds
// anything; this only removes a <mark data-qid> that is completely empty
// (whitespace-only) — the signature of a Range.extractContents() clone
// shell that ended up with no text moved into it. Deliberately narrow:
// an earlier version of this backstop also collapsed adjacent sibling
// marks that shared identical text, but that rule could delete two
// *legitimately distinct* marks that just happened to wrap the same
// short word (e.g. the same answer term highlighted at two separate
// occurrences) — real highlighted content, not an artifact — so it was
// dropped. Only ever removes marks that can't possibly be carrying real,
// wanted highlighted text.
function dedupeMarks(container) {
  Array.from(container.querySelectorAll('mark[data-qid]')).forEach(mark => {
    if (!mark.textContent || !mark.textContent.trim()) {
      const parent = mark.parentNode;
      if (parent) parent.removeChild(mark);
    }
  });
  container.normalize();
}

// True if this qid/type currently has at least one similarity-fallback
// ("best guess") mark on the page rather than a confidently exact one.
// recheckHighlights uses this so a previously-fuzzy match doesn't get
// silently reclassified as fully resolved just because its substitute
// sentence happens to be close in length to the real snippet.
// ---------------------------------------------------------------------
// Verbatim from source, lines 2355-2357
// ---------------------------------------------------------------------
function hasFuzzyMark(pageBody, qid, type) {
  return !!pageBody.querySelector(`mark[data-qid~="${qid}"][data-snippet-type="${type}"][data-fuzzy="true"]`);
}

// Total whitespace-normalized length of whatever's currently marked
// for this qid/type on the page — used to tell "fully highlighted"
// apart from "only some of it took" without needing to re-derive exact
// offsets. A snippet crossing block boundaries legitimately becomes
// several <mark>s (see highlightSnippetInContainer's comments), so
// "found at least one mark" alone isn't enough to call it complete.
// ---------------------------------------------------------------------
// Verbatim from source, lines 2365-2370
// ---------------------------------------------------------------------
function markedTextLength(pageBody, qid, type) {
  const marks = pageBody.querySelectorAll(`mark[data-qid~="${qid}"][data-snippet-type="${type}"]`);
  let text = '';
  marks.forEach(m => { text += m.textContent; });
  return normalizeWhitespace(text).length;
}

// Sørensen-Dice bigram similarity, 0 (nothing alike) to 1 (identical
// once case/non-alphanumerics are stripped). Used by recheckHighlights
// as a last-resort fallback: when a snippet no longer appears verbatim
// anywhere on its page (e.g. Format Layout reworded it), this finds
// whichever sentence on the page is the closest overall match so the
// highlight can at least land near the right spot instead of vanishing.
// ---------------------------------------------------------------------
// Verbatim from source, lines 2378-2401
// ---------------------------------------------------------------------
function calculateSimilarity(str1, str2) {
  const s1 = (str1 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = (str2 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;
  const getBigrams = (s) => {
    const bg = [];
    for (let i = 0; i < s.length - 1; i++) bg.push(s.slice(i, i + 2));
    return bg;
  };
  const bg1 = getBigrams(s1);
  const bg2 = getBigrams(s2);
  let matches = 0;

  const bg2Temp = [...bg2];
  for (const b of bg1) {
    const index = bg2Temp.indexOf(b);
    if (index !== -1) {
      matches++;
      bg2Temp.splice(index, 1);
    }
  }
  return (2.0 * matches) / (bg1.length + bg2.length);
}

// Splits a page's rendered text into candidate sentences for the
// similarity scan above. Pulled from pageBody.textContent (not the
// original extracted page text) so a matched sentence is guaranteed to
// be an exact, highlightable substring of what's actually in the DOM
// right now.
// ---------------------------------------------------------------------
// Verbatim from source, lines 2408-2410
// ---------------------------------------------------------------------
function extractSentences(text) {
  return (text || '').split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 10);
}

// How similar (0-1) a fallback sentence must be to a snippet before
// recheckHighlights will accept it as a stand-in match. Below this,
// the "closest" sentence still isn't close enough to be useful and the
// question is reported as genuinely unresolved instead.
// ---------------------------------------------------------------------
// Verbatim from source, line 2416
// ---------------------------------------------------------------------
const SIMILARITY_FALLBACK_THRESHOLD = 0.4; // SUPPRESS_UNCHECKED_INDICATOR_FOR_DUPLICATES_PROMPT.md Part C: 0.5 -> 0.4

// UNCHECKED_AI_CONTENT_AND_FUZZY_HIGHLIGHT_PERSISTENCE_PROMPT.md Part A —
// shared per-slot location ladder: own-page attempt -> document-wide
// fuzzy sentence-similarity scan -> raw answer/target-term-only
// fallback. This is the same ladder recheckHighlightsForQuestion() used
// to run inline (own-page relocate at verifyTier 2, fuzzy at 3,
// term-only at 4) — pulled out here so renderTextVersion()
// (layout-formatting.js) can run the identical ladder on every render
// instead of only ever attempting an exact match and dropping anything
// else, and so recheckHighlightsForQuestion() no longer duplicates the
// logic inline.
//
// `ownPageVerifyTier` is the verify tier to record if the snippet is
// found on the question's own stated page: callers with no pre-existing
// marks to worry about (renderTextVersion(), building Pane 2 from
// scratch) pass 1 — this is a first/only attempt, and
// highlightSnippetInContainer's own exact + punctuation-stripped +
// list-conjunction fallbacks already cover "exact or near-exact enough
// to count as Tier 1". recheckHighlightsForQuestion() only reaches this
// helper after its own "already fine" fast-path check (against
// possibly-stale existing marks) has already ruled out Tier 1, so it
// passes 2 — this is a *relocation*, not a fresh exact match.
//
// NOTE (scope decision, not silently made): recheckHighlights() — the
// *batch* recheck-all-questions function — is intentionally left
// calling its own inline own-page/fuzzy/term-only logic rather than
// this helper. Its Phase 2 doc-wide fuzzy scan deliberately extracts
// each page's sentences exactly once and scores every still-open
// candidate against them in the same pass (see that function's own
// header comment) specifically to stay O(pages) instead of
// O(candidates x pages). Routing it through this helper — which
// re-extracts sentences fresh per single-slot call — would silently
// undo that optimization on every full-document recheck. Flagged here
// rather than done, per this prompt's own instruction to flag
// tradeoffs instead of accepting them quietly.
//
// Returns `{ verifyTier, pageNum, score }` describing where/how it was
// found (score is only set for a Tier 3 fuzzy match), or `null` if the
// snippet couldn't be located anywhere by any rung of the ladder.
function locateAndHighlightSnippet(docContainer, q, type, ownPageVerifyTier) {
  const snippet = type === 'answer' ? q.answerSnippet : q.sourceSnippet;
  if (!snippet) return null;
  const expectedLen = normalizeWhitespace(snippet).length;
  const pageBody = docContainer.querySelector(`.doc-page[data-page="${q.sourcePage}"] .doc-page-body`);

  // Rung 1/2 — own stated page (exact/punctuation/list-conjunction
  // fallbacks all live inside highlightSnippetInContainer itself).
  if (pageBody) {
    unwrapMarksForQuestion(pageBody, q.id, type);
    highlightSnippetInContainer(pageBody, snippet, q.id, type, q.tier, ownPageVerifyTier);
    // SUPPRESS_UNCHECKED_INDICATOR_FOR_DUPLICATES_PROMPT.md Part C:
    // 0.9 -> 0.4 — legitimate rephrased/reworded content should clear
    // this bar more easily.
    if (expectedLen > 0 && markedTextLength(pageBody, q.id, type) >= expectedLen * 0.4) {
      return { verifyTier: ownPageVerifyTier, pageNum: q.sourcePage, score: null };
    }
  }

  // Rung 3 — document-wide fuzzy sentence-similarity scan.
  unwrapMarksForQuestion(docContainer, q.id, type);
  let best = null; // { score, sentence, pageNum, pageBody }
  docContainer.querySelectorAll('.doc-page').forEach(pageEl => {
    const body = pageEl.querySelector('.doc-page-body');
    if (!body) return;
    const pageNum = Number(pageEl.dataset.page);
    const sentences = extractSentences(body.textContent);
    sentences.forEach(sentence => {
      const score = calculateSimilarity(sentence, snippet);
      if (!best || score > best.score) {
        best = { score, sentence, pageNum, pageBody: body };
      }
    });
  });

  if (best && best.score >= SIMILARITY_FALLBACK_THRESHOLD) {
    highlightSnippetInContainer(best.pageBody, best.sentence, q.id, type, q.tier, 3);
    if (markedTextLength(docContainer, q.id, type) > 0) {
      return { verifyTier: 3, pageNum: best.pageNum, score: best.score };
    }
  }

  // Rung 4 — last resort: is the raw answer/target term itself findable
  // anywhere at all?
  const termNeedle = type === 'answer' ? snippet : (q.targetTerm || q.answerSnippet || '');
  const termPage = termNeedle
    ? state.pages.find(p => fuzzyIncludes(cleanExtractedText(p.text), termNeedle))
    : null;
  if (termPage) {
    const termPageBody = docContainer.querySelector(`.doc-page[data-page="${termPage.pageNumber}"] .doc-page-body`);
    if (termPageBody) highlightSnippetInContainer(termPageBody, termNeedle, q.id, type, q.tier, 4);
    if (termPageBody && markedTextLength(docContainer, q.id, type) > 0) {
      return { verifyTier: 4, pageNum: termPage.pageNumber, score: null };
    }
  }

  return null; // genuinely not present anywhere, even after every fallback rung
}

// =====================================================================
// Highlight recheck.
//
// DUPLICATE_MARK_RESYNC_STRIP_FIX_PROMPT_V2.md — this used to be an
// *incremental* checker: for each question it first checked whether the
// mark already on the live DOM still covered enough of the expected
// text, and only escalated through fallback tiers (own-page retry ->
// doc-wide fuzzy scan -> term-only) if that failed. That escalation path
// removed the existing mark before a replacement was guaranteed, which
// was the suspected root of a long-running bug: after "Remove
// Duplicates" then "Sync Highlights", an AI-generated question's
// highlight could disappear from Pane 2 entirely.
//
// renderTextVersion() (layout-formatting.js) never showed that bug — it
// wipes docTextContainer.innerHTML and redraws every question's
// highlight from scratch via the same underlying ladder
// (locateAndHighlightSnippet: own-page exact -> doc-wide fuzzy ->
// term-only), so there's never a stale mark to trip over. Rather than
// keep chasing the incremental path's escalation bug, recheckHighlights()
// now just does what renderTextVersion() does: a full rebuild. It calls
// renderTextVersion() directly and reconstructs the
// verifyTier/sourceFound/answerFound bookkeeping and status message
// below from what that rebuild's ladder actually found per question/slot
// (renderTextVersion() returns a `qid -> { question, answer }` results
// map for exactly this purpose — see its own header comment in
// layout-formatting.js).
//
// Never touches importance (q.tier) — but DOES update q.verifyTier (the
// worse of a question's question-snippet and answer-snippet
// verification results this pass), so the editor badge stays in sync
// with the marks in Pane 2.
// =====================================================================
function recheckHighlights() {
  if (state.questions.length === 0) {
    setSelectionGenStatus('No questions to check.', 'error');
    setTimeout(() => setSelectionGenStatus(''), 2500);
    return;
  }

  // The one full rebuild this pass needs — draws every question's
  // highlight fresh against a clean DOM and reports back what its ladder
  // found for each question/slot. syncMarkActiveAndUncheckedState's
  // active/unchecked-class sync and the dedupeMarks/logAllHighlights
  // diagnostic calls are already handled inside renderTextVersion()
  // itself, so nothing extra is needed here for any of that.
  const results = renderTextVersion();

  let ok = 0; // Tier 1 — exact/near-exact own-page match this pass.
  let fuzzyMatched = 0; // Tier 3 — doc-wide similarity fallback.
  let unclassifiedCount = 0; // Tier 4 — term-only fallback.
  const stillMissing = [];
  const fuzzyNotes = [];
  const unclassifiedNotes = [];

  // DUPLICATE_MARK_RESYNC_STRIP_FIX_PROMPT_V2.md — one legitimate
  // semantic change from the old incremental version: its Tier 2
  // ("relocated on retry") only existed because it tried an own-page
  // exact match, failed against a stale mark, unwrapped, and retried.
  // With a full rebuild every own-page exact match is just a fresh
  // Tier 1 result — there's no more meaningful distinction between
  // "matched immediately" and "matched after a retry", because there's
  // no retry anymore, just one clean attempt. The old "relocated" count
  // is folded into the Tier 1 / "ok" count below rather than trying to
  // preserve a Tier 2 bucket that no longer means anything.

  state.questions.forEach((q, i) => {
    const label = 'Q' + String(i + 1).padStart(2, '0');
    const entry = results.get(q.id) || { question: null, answer: null };
    const slotTiers = []; // this question's tier(s) actually checked this pass

    [
      { type: 'question', snippet: q.sourceSnippet },
      { type: 'answer', snippet: q.answerSnippet },
    ].forEach(({ type, snippet }) => {
      if (!snippet) return; // nothing to check for this slot — mirror
      // today's 'question' in found / 'answer' in found guards: a
      // question with no answerSnippet yet shouldn't have answerFound
      // touched at all.

      const located = entry[type];
      // sourceFound/answerFound feed computeDataClassification()
      // (question-model.js)'s Verified/Unverified distinction — true if
      // located at ANY tier, including the Tier 4 term-only fallback,
      // same semantics as before.
      if (type === 'question') q.sourceFound = !!located;
      else q.answerFound = !!located;

      if (!located) {
        // A null result counts as the worst case (tier 4) for this
        // question's verifyTier — same as the old bumpVerifyTier
        // treatment of a total miss.
        slotTiers.push(4);
        stillMissing.push({
          label, type,
          reason: `text (and its answer/target term) no longer matches anywhere in the document`,
        });
        return;
      }

      slotTiers.push(located.verifyTier);
      if (located.verifyTier === 1) {
        ok++;
      } else if (located.verifyTier === 3) {
        fuzzyMatched++;
        const pageNote = located.pageNum !== q.sourcePage ? ` (found on p.${located.pageNum}, not its stated p.${q.sourcePage})` : '';
        fuzzyNotes.push({
          label, type,
          reason: `no exact match — highlighted the closest sentence instead (${Math.round(located.score * 100)}% similar)${pageNote}; please verify it's correct`,
        });
      } else { // tier 4 — located, but only via the term-only fallback
        unclassifiedCount++;
        const pageNote = located.pageNum !== q.sourcePage ? ` on p.${located.pageNum}` : '';
        unclassifiedNotes.push({
          label, type,
          reason: `context snippet not found anywhere — only the answer/target term was located${pageNote}`,
        });
      }
    });

    // q.verifyTier is the worse (higher) of this question's slot
    // results this pass — only touched if at least one slot actually
    // had a snippet to check, same as before.
    if (slotTiers.length > 0) q.verifyTier = Math.max(...slotTiers);
  });

  renderQuestionNav();
  if (state.activeCardId) renderActiveQuestion();

  if (fuzzyNotes.length > 0) {
    console.warn('Highlight recheck — Tier 3 approximate (similarity-fallback) matches, please verify:', fuzzyNotes);
  }
  if (unclassifiedNotes.length > 0) {
    console.warn('Highlight recheck — Tier 4 unclassified (term-only) matches, please verify:', unclassifiedNotes);
  }

  if (stillMissing.length === 0) {
    const parts = [];
    if (fuzzyMatched > 0) parts.push(`${fuzzyMatched} Tier 3 approximate (verify)`);
    if (unclassifiedCount > 0) parts.push(`${unclassifiedCount} Tier 4 unclassified (verify)`);
    parts.push(`${ok} already fine`);
    const needsReview = fuzzyMatched > 0 || unclassifiedCount > 0;
    setSelectionGenStatus(
      needsReview
        ? `Recheck complete — ${parts.join(', ')}.`
        : `Recheck complete — all ${ok} highlights are fine.`,
      needsReview ? 'error' : 'success' // 'error' tone here just flags "needs a look", not a real failure
    );
  } else {
    console.warn('Highlight recheck — still unresolved:', stillMissing);
    const preview = stillMissing.slice(0, 4).map(m => `${m.label} (${m.type}): ${m.reason}`).join(' · ');
    const extraParts = [];
    if (fuzzyMatched > 0) extraParts.push(`${fuzzyMatched} Tier 3 approximate`);
    if (unclassifiedCount > 0) extraParts.push(`${unclassifiedCount} Tier 4 unclassified`);
    const extraPart = extraParts.length ? `, ${extraParts.join(', ')}` : '';
    setSelectionGenStatus(
      `Recheck: ${ok} fine${extraPart}, ${stillMissing.length} still unresolved — ${preview}${stillMissing.length > 4 ? ' …see console' : ''}`,
      'error'
    );
  }

  // DIAGNOSTIC (temporary, see HIGHLIGHT_DUMP_DIAGNOSTIC_PROMPT.md /
  // HIGHLIGHT_DUMP_FOLLOWUP_PROMPT.md): dump the DOM's actual mark state
  // right after this batch recheck finishes. renderTextVersion() already
  // logs its own 'end of renderTextVersion' dump internally, so this is
  // a distinct trace point (after this function's own status-message
  // processing) rather than a duplicate of that one.
  logAllHighlights('end of recheckHighlights (batch)');
}
// ---------------------------------------------------------------------
// Verbatim from source, line 2703 (event wiring that belongs to this
// module's own function — moved with handler per the schema's strategy)
// ---------------------------------------------------------------------
recheckHighlightsBtn.addEventListener('click', recheckHighlights);

// Single-question version of recheckHighlights above — same
// exact-match -> own-page relocate -> document-wide fuzzy -> term-only
// fallback ladder, just scoped to one question instead of batching
// every question in the collection. This is what the per-question
// "🔎 Recheck this question" button calls, so a single edit doesn't
// require re-running the full document-wide recheck (and doesn't risk
// nudging every other question's verify tier while you're mid-edit on
// just one).
// ---------------------------------------------------------------------
// Verbatim from source, lines 2713-2821
// ---------------------------------------------------------------------
function recheckHighlightsForQuestion(qid) {
  const q = state.questions.find(x => x.id === qid);
  if (!q) return;

  const slots = [
    { snippet: q.sourceSnippet, type: 'question' },
    { snippet: q.answerSnippet, type: 'answer' },
  ].filter(s => s.snippet);

  if (slots.length === 0) {
    setSelectionGenStatus('This question has no source/answer snippet to check yet.', 'error');
    setTimeout(() => setSelectionGenStatus(''), 2500);
    return;
  }

  let worstTier = 1;
  const notes = [];
  // Per-slot found flags for this question — see the same-named map in
  // recheckHighlights() above for why this can't just be derived from
  // worstTier (a term-only match and a total miss both max it to 4).
  const found = {};

  slots.forEach(({ snippet, type }) => {
    const ownPageBody = docTextContainer.querySelector(`.doc-page[data-page="${q.sourcePage}"] .doc-page-body`);
    const expectedLen = normalizeWhitespace(snippet).length;

    if (ownPageBody) {
      const existingLen = markedTextLength(ownPageBody, q.id, type);
      // SUPPRESS_UNCHECKED_INDICATOR_FOR_DUPLICATES_PROMPT.md Part C:
      // 0.9 -> 0.4 — legitimate rephrased/reworded content should clear
      // this bar more easily.
      if (!hasFuzzyMark(ownPageBody, q.id, type) && expectedLen > 0 && existingLen >= expectedLen * 0.4) {
        notes.push(`${type}: already fine`);
        found[type] = true;
        return; // worstTier stays at whatever it already was — this slot is confirmed
      }
    }

    // UNCHECKED_AI_CONTENT_AND_FUZZY_HIGHLIGHT_PERSISTENCE_PROMPT.md
    // Part A — own-page relocate -> doc-wide fuzzy -> term-only ladder
    // now lives in the shared locateAndHighlightSnippet() helper above
    // (also used by renderTextVersion() in layout-formatting.js)
    // instead of being duplicated here. verifyTier 2 for an own-page
    // find, since the "already fine" fast-path above already ruled out
    // Tier 1 for this slot.
    const located = locateAndHighlightSnippet(docTextContainer, q, type, 2);
    if (located) {
      worstTier = Math.max(worstTier, located.verifyTier);
      found[type] = true;
      if (located.verifyTier === 2) {
        notes.push(`${type}: relocated on its own page`);
      } else if (located.verifyTier === 3) {
        const pageNote = located.pageNum !== q.sourcePage ? ` (found on p.${located.pageNum}, not its stated p.${q.sourcePage})` : '';
        notes.push(`${type}: no exact match — closest sentence used instead (${Math.round(located.score * 100)}% similar)${pageNote}, please verify`);
      } else {
        const pageNote = located.pageNum !== q.sourcePage ? ` on p.${located.pageNum}` : '';
        notes.push(`${type}: context not found anywhere — only the answer/target term was located${pageNote}`);
      }
      return;
    }

    worstTier = Math.max(worstTier, 4);
    found[type] = false; // genuinely un-highlightable — this is what makes a question "Unverified"
    notes.push(`${type}: still not found anywhere in the document`);
  });

  q.verifyTier = worstTier;
  if ('question' in found) q.sourceFound = found.question;
  if ('answer' in found) q.answerFound = found.answer;
  renderQuestionNav();
  if (state.activeCardId === qid) renderActiveQuestion();
  // UNCHECKED_AI_CONTENT_AND_FUZZY_HIGHLIGHT_PERSISTENCE_PROMPT.md
  // Part B — same unguarded-loop treatment as recheckHighlights() above:
  // this also keeps unchecked-highlight in sync, which must apply even
  // when nothing is currently active.
  // SUPPRESS_UNCHECKED_INDICATOR_FOR_DUPLICATES_PROMPT.md: `&&
  // !markDup` added — same suppression as the other five sites this
  // touches (see editor-render.js and layout-formatting.js).
  // HIGHLIGHT_DUPLICATE_SHARED_MARK_FIX_PROMPT.md: see
  // syncMarkActiveAndUncheckedState's comment (same function used above
  // in recheckHighlights()).
  syncMarkActiveAndUncheckedState(state.activeCardId);

  // Defensive backstop only — see dedupeMarks' header comment.
  dedupeMarks(docTextContainer);

  console.info(`Recheck (single question ${qid}):`, notes);
  setSelectionGenStatus(notes.join(' · '), worstTier >= 3 ? 'error' : 'success');
  setTimeout(() => setSelectionGenStatus(''), 4000);
}

// DIAGNOSTIC ONLY — added by QUIVER_HIGHLIGHT_DUMP_DIAGNOSTIC_PROMPT.md to
// investigate the "questions end up with no highlight at all" regression.
// Not part of the app's real logic; safe to delete once that
// investigation is done. Dumps every <mark data-qid> currently in the
// DOM, grouped by question id, plus the list of questions that have a
// sourceSnippet/answerSnippet defined but no corresponding mark anywhere
// — call sites (in layout-formatting.js) bracket the AI-layout-format
// flow so the console trail shows exactly when marks appear/disappear.
// `data-tier` on each <mark> actually holds the *verify* tier
// (resolvedVerify from highlightSnippetInContainer), not the importance
// tier — matched here via m.dataset.tier to reflect the real attribute.
function logAllHighlights(label) {
  const marks = Array.from(docTextContainer.querySelectorAll('mark[data-qid]'));
  const byQid = {};
  marks.forEach(m => {
    const type = m.dataset.snippetType; // 'question' | 'answer'
    const pageEl = m.closest('.doc-page');
    const page = pageEl ? pageEl.dataset.page : null;
    // HIGHLIGHT_DUPLICATE_SHARED_MARK_FIX_PROMPT.md: a shared mark (see the
    // multi-qid mark helpers near the top of this file) carries more than
    // one qid — attribute this one <mark> to EVERY question it belongs to,
    // not just a single (and now potentially bogus, e.g. "q_3 q_7") key.
    markQidList(m).forEach(qid => {
      if (!byQid[qid]) byQid[qid] = { question: 0, answer: 0, entries: [] };
      if (type === 'question' || type === 'answer') byQid[qid][type] += 1;
      byQid[qid].entries.push({
        type,
        tier: m.dataset.tier, // verify tier, see comment above
        page,
        text: (m.textContent || '').slice(0, 60),
        shared: markQidList(m).length > 1 ? markQidList(m) : undefined,
      });
    });
  });

  // Which questions HAVE a snippet defined but NO mark for it anywhere in the DOM.
  const missing = [];
  state.questions.forEach(q => {
    const marksForQ = byQid[q.id] || { question: 0, answer: 0 };
    if (q.sourceSnippet && marksForQ.question === 0) {
      missing.push({ qid: q.id, type: 'question', sourcePage: q.sourcePage, snippetPreview: q.sourceSnippet.slice(0, 60) });
    }
    if (q.answerSnippet && marksForQ.answer === 0) {
      missing.push({ qid: q.id, type: 'answer', sourcePage: q.sourcePage, snippetPreview: q.answerSnippet.slice(0, 60) });
    }
  });

  console.log(`[highlight-dump] ${label}`, {
    totalMarksInDom: marks.length,
    questionsWithAnyMark: Object.keys(byQid).length,
    totalQuestions: state.questions.length,
    missingCount: missing.length,
    missing,
    byQid,
  });
}

export {
  fuzzyIncludes,
  highlightBlockAncestorOf,
  buildNormalizedContainerIndex,
  stripPunctuationKeepMap,
  stripListConjunctionsKeepMap,
  highlightSnippetInContainer,
  widenRangeToAvoidPartialMarks,
  unwrapMarksForQuestion,
  dedupeMarks,
  hasFuzzyMark,
  markedTextLength,
  calculateSimilarity,
  extractSentences,
  locateAndHighlightSnippet,
  recheckHighlights,
  recheckHighlightsForQuestion,
  logAllHighlights,
  // HIGHLIGHT_DUPLICATE_SHARED_MARK_FIX_PROMPT.md — multi-qid mark helpers,
  // needed by every other module that reads a <mark>'s data-qid as a
  // single id (editor-render.js, layout-formatting.js).
  markQidList,
  markHasQid,
  areDuplicateQids,
};
