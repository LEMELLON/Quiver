// --- Shared dependencies ---
import { state, getDuplicateMap } from './core-state.js';
import { docTextContainer, recheckHighlightsBtn } from './dom-refs.js';
import { TIER_META } from './classification-meta.js';
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
import { renderTextVersion } from './layout-formatting.js';

// Syncs active/unchecked highlight classes on every mark; a shared mark lights up if any of its qids matches.
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

// True if qidA and qidB are flagged as duplicates of each other, checked in both directions.
function areDuplicateQids(qidA, qidB) {
  if (!qidA || !qidB || qidA === qidB) return false;
  const map = getDuplicateMap();
  return (map.get(qidA) || {}).matchId === qidB || (map.get(qidB) || {}).matchId === qidA;
}

// Removes a single <mark>, moving its children back into its parent in place. Never calls parent.normalize().
function unwrapMarkElement(mark) {
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
}

// For type === 'question' only: checks whether `range` overlaps an existing duplicate-related mark before drawing a new one.
// Returns { skip: true } if fully covered by an existing mark (qid folded in), { extraIds } if it swallows smaller marks, or null.
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

    const overlaps =
      range.compareBoundaryPoints(Range.START_TO_END, markRange) < 0 &&
      range.compareBoundaryPoints(Range.END_TO_START, markRange) > 0;
    if (!overlaps) continue;

    const markStartsBeforeOrAtRange = range.compareBoundaryPoints(Range.START_TO_START, markRange) >= 0;
    const markEndsAfterOrAtRange = range.compareBoundaryPoints(Range.END_TO_END, markRange) <= 0;
    const existingContainsNew = markStartsBeforeOrAtRange && markEndsAfterOrAtRange;

    if (existingContainsNew) {
      if (!ids.includes(qid)) mark.dataset.qid = ids.concat(qid).join(' ');
      return { skip: true };
    }

    const rangeStartsBeforeOrAtMark = range.compareBoundaryPoints(Range.START_TO_START, markRange) <= 0;
    const rangeEndsAfterOrAtMark = range.compareBoundaryPoints(Range.END_TO_END, markRange) >= 0;
    const newContainsExisting = rangeStartsBeforeOrAtMark && rangeEndsAfterOrAtMark;

    if (newContainsExisting) {
      extraIds.push(...ids);
      unwrapMarkElement(mark);
      continue; // keep scanning — more than one small mark could be swallowed
    }
    // Partial overlap only — left for the widen-to-fully-contain fallback below; mergeNestedDuplicateMarks catches it after insert.
  }
  return extraIds.length ? { extraIds } : null;
}

// Safety net: unwraps any duplicate-related question mark left nested inside outerMark and folds its id(s) in.
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

// True if `needle` is present in `haystack` after whitespace normalization, punctuation stripping, or list-conjunction stripping.
function fuzzyIncludes(haystack, needle) {
  if (!needle) return false;
  const normHaystack = normalizeWhitespace(haystack);
  const normNeedle = normalizeWhitespace(needle);
  if (normHaystack.includes(normNeedle)) return true;

  const strippedNeedle = stripPunctuationForMatch(normNeedle);
  if (strippedNeedle && stripPunctuationForMatch(normHaystack).includes(strippedNeedle)) return true;

  const listNeedle = stripListConjunctionsForMatch(normNeedle);
  if (!listNeedle) return false;
  return stripListConjunctionsForMatch(normHaystack).includes(listNeedle);
}

// Block-level tags needing a synthetic separating space in normalized text.
const HIGHLIGHT_BLOCK_TAGS = new Set([
  'P', 'LI', 'DIV', 'TR', 'TD', 'TH', 'TABLE', 'UL', 'OL', 'BR',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE'
]);

// Nearest block-level ancestor of `node` (or `container` itself).
function highlightBlockAncestorOf(node, container) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== container) {
    if (HIGHLIGHT_BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return container;
}

// Walks every text node under `container`, producing a whitespace-collapsed string plus a parallel offset-to-node map.
// Wrapping text in <mark>s never changes this string, so index ranges stay valid across highlight calls on the same container.
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
      } else {
        chars.push(ch);
        map.push({ node, offset: i, block });
        lastWasSpace = false;
      }
    }
  }

  if (chars.length && chars[chars.length - 1] === ' ') {
    chars.pop();
    map.pop();
  }

  return { normalized: chars.join(''), map };
}

// Strips punctuation from str, returning the stripped string plus a map from each stripped index back to its original index.
function stripPunctuationKeepMap(str) {
  const chars = [];
  const map = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    SNIPPET_PUNCTUATION_RE.lastIndex = 0; // the regex has the /g flag, so test() is stateful; reset before every call
    if (SNIPPET_PUNCTUATION_RE.test(ch)) continue;
    chars.push(ch);
    map.push(i);
  }
  SNIPPET_PUNCTUATION_RE.lastIndex = 0;
  return { stripped: chars.join(''), map };
}

// Same as stripPunctuationKeepMap but also drops standalone "and"/"or" connector words.
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

// Finds every match of `snippet` in `normalized` (exact first, then punctuation-stripped, then list-conjunction-stripped),
// restricted to scope { startIdx, endIdx(exclusive) } when given. Returns [{ idx, len }] in `normalized` coordinates, in order.
function findMatchesInIndex(normalized, snippet, scope) {
  const needle = normalizeWhitespace(snippet);
  if (!needle) return [];
  const lo = scope ? Math.max(0, scope.startIdx) : 0;
  const hi = scope ? Math.min(normalized.length, scope.endIdx) : normalized.length;
  if (hi <= lo) return [];

  let out = [];
  let from = lo;
  while (true) {
    const i = normalized.indexOf(needle, from);
    if (i === -1 || i + needle.length > hi) break;
    out.push({ idx: i, len: needle.length });
    from = i + 1;
  }
  if (out.length) return out;

  const collectStripped = (hay, map, strippedNeedle) => {
    const found = [];
    if (!strippedNeedle) return found;
    let f = 0;
    while (true) {
      const si = hay.indexOf(strippedNeedle, f);
      if (si === -1) break;
      const start = map[si];
      const end = map[si + strippedNeedle.length - 1]; // inclusive
      if (start >= lo && end < hi) found.push({ idx: start, len: end - start + 1 });
      f = si + 1;
    }
    return found;
  };

  const punct = stripPunctuationKeepMap(normalized);
  out = collectStripped(punct.stripped, punct.map, stripPunctuationForMatch(needle));
  if (out.length) return out;

  const list = stripListConjunctionsKeepMap(normalized);
  return collectStripped(list.stripped, list.map, stripListConjunctionsForMatch(needle));
}

// Picks the occurrence-th match (clamped to the last one) from findMatchesInIndex; returns { idx, len, count } or null.
function resolveSnippetMatch(normalized, snippet, scope, occurrence) {
  const matches = findMatchesInIndex(normalized, snippet, scope);
  if (!matches.length) return null;
  const want = Number.isInteger(occurrence) && occurrence > 0 ? occurrence : 0;
  const m = matches[Math.min(want, matches.length - 1)];
  return { idx: m.idx, len: m.len, count: matches.length };
}

// Resolves where `snippet` would land in `container` without touching the DOM: { startIdx, endIdx(exclusive), matchCount } or null.
function findSnippetRange(container, snippet, scope, occurrence) {
  if (!container) return null;
  const { normalized, map } = buildNormalizedContainerIndex(container);
  if (!map.length) return null;
  const m = resolveSnippetMatch(normalized, snippet, scope || null, occurrence || 0);
  return m ? { startIdx: m.idx, endIdx: m.idx + m.len, matchCount: m.count } : null;
}

// Converts a live selection Range into whitespace-trimmed { startIdx, endIdx(exclusive) } in `container`'s normalized space.
// Returns null if the range is detached, outside the container, or covers no text.
function selectionRangeIdx(container, selRange) {
  if (!container || !selRange || !selRange.startContainer || !selRange.endContainer) return null;
  if (!selRange.startContainer.isConnected || !selRange.endContainer.isConnected) return null;
  if (!container.contains(selRange.startContainer) || !container.contains(selRange.endContainer)) return null;
  const { normalized, map } = buildNormalizedContainerIndex(container);
  if (!map.length) return null;

  let start = -1;
  let end = -1;
  for (let i = 0; i < map.length; i++) {
    const e = map[i];
    const len = e.node.nodeValue.length;
    let startsIn, endsIn;
    try {
      startsIn = selRange.comparePoint(e.node, e.offset) === 0;
      endsIn = selRange.comparePoint(e.node, Math.min(e.offset + 1, len)) === 0;
    } catch (err) {
      continue;
    }
    if (startsIn && endsIn) {
      if (start === -1) start = i;
      end = i + 1;
    }
  }
  if (start === -1) return null;
  while (start < end && normalized[start] === ' ') start++;
  while (end > start && normalized[end - 1] === ' ') end--;
  return start < end ? { startIdx: start, endIdx: end } : null;
}

// Counts how many matches of `snippet` inside parentRange (or the whole container) start before the selection start,
// i.e. which occurrence the person actually selected. Returns 0 when the selection can't be mapped (e.g. a stale Range).
function computeOccurrenceIndex(container, parentRange, snippet, selectionRange) {
  const sel = selectionRangeIdx(container, selectionRange);
  if (!sel) return 0;
  const { normalized } = buildNormalizedContainerIndex(container);
  const matches = findMatchesInIndex(normalized, snippet, parentRange || null);
  let n = 0;
  for (const m of matches) {
    if (m.idx < sel.startIdx) n++; else break;
  }
  return n;
}

// Locates `snippet` inside `container`'s rendered text and wraps it in one or more <mark data-qid="…"> elements without
// disturbing surrounding markup. `type` is 'source' (subtle outer wrapper), 'question' (colored by importanceTier) or
// 'answer' (always green). A match spanning block boundaries is split into one <mark> per block segment.
// opts.scope ({ startIdx, endIdx } in buildNormalizedContainerIndex space) limits the search; opts.occurrence picks the Nth match.
// Returns { startIdx, endIdx(exclusive), matchCount } of the resolved match, or null if nothing was found/wrapped.
// importanceTier drives the mark's background color; verifyTier drives the separate V1-V4 badge — independent of each other.
function highlightSnippetInContainer(container, snippet, qid, type, importanceTier, verifyTier, opts) {
  const normalizedSnippet = normalizeWhitespace(snippet);
  if (!normalizedSnippet) return null;

  const scope = (opts && opts.scope) || null;
  const occurrence = (opts && opts.occurrence) || 0;
  const snippetType = type === 'answer' ? 'answer' : type === 'source' ? 'source' : 'question';

  const resolvedImportance = importanceTier === 2 || importanceTier === 3 ? importanceTier : 1;
  const cssClass = snippetType === 'answer'
    ? 'source-highlight-answer'
    : snippetType === 'source'
      ? 'source-highlight-source'
      : (TIER_META[resolvedImportance] || TIER_META[1]).highlightClass;
  const resolvedVerify = [1, 2, 3, 4].includes(verifyTier) ? verifyTier : 1;
  const { normalized, map } = buildNormalizedContainerIndex(container);
  if (!map.length) return null;

  const match = resolveSnippetMatch(normalized, normalizedSnippet, scope, occurrence);
  if (!match) return null; // genuinely not present (in scope), even after every fallback pass — no-op

  const idx = match.idx;
  const endIdx = idx + match.len - 1; // inclusive index of last matched char

  // Group the matched span into contiguous runs sharing the same block-level ancestor, in document order.
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

  let wrapped = 0;
  groups.forEach(g => {
    try {
      const range = document.createRange();
      range.setStart(g.startNode, g.startOffset);
      range.setEnd(g.endNode, g.endOffset);

      // For a 'question' mark, check for an overlapping duplicate-related mark before the normal widen/extract/nest path.
      let extraQidsForNewMark = [];
      if (snippetType === 'question') {
        const shareResult = tryShareDuplicateMark(container, range, qid);
        if (shareResult && shareResult.skip) { wrapped++; return; } // folded into an existing mark — no new <mark> needed
        if (shareResult && shareResult.extraIds) extraQidsForNewMark = shareResult.extraIds;
      }

      // Widen the range so any partially-overlapped <mark> becomes fully contained, so extractContents moves (not clones) it.
      widenRangeToAvoidPartialMarks(container, range);
      const mark = document.createElement('mark');
      mark.className = cssClass;
      mark.dataset.qid = extraQidsForNewMark.length
        ? Array.from(new Set([...extraQidsForNewMark, qid])).join(' ')
        : qid;
      mark.dataset.snippetType = snippetType;
      mark.dataset.tier = String(resolvedVerify);
      if (resolvedVerify >= 3) mark.dataset.fuzzy = 'true';
      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);
      wrapped++;

      // Un-nest any duplicate-related mark the widen step above may have nested inside `mark`.
      if (snippetType === 'question') mergeNestedDuplicateMarks(mark, qid);
    } catch (e) {
      console.warn('highlightSnippetInContainer: a matched segment could not be wrapped and was skipped', { qid, type, snippet });
    }
  });

  return wrapped > 0 ? { startIdx: idx, endIdx: idx + match.len, matchCount: match.count } : null;
}

// Widens `range` in place so no existing <mark data-qid> is PARTIALLY inside it (a mark that straddles one boundary);
// runs to a fixed point. A mark that fully contains the range (e.g. a source mark around a question) is nesting, not
// overlap, and is left alone — as are source marks entirely, which may be split by extractContents instead.
function widenRangeToAvoidPartialMarks(container, range) {
  let changed = true;
  let guard = 0;
  while (changed && guard < 25) {
    changed = false;
    guard++;
    const marks = container.querySelectorAll('mark[data-qid]:not([data-snippet-type="source"])');
    for (const mark of marks) {
      const startInside = mark.contains(range.startContainer);
      const endInside = mark.contains(range.endContainer);
      if (startInside === endInside) continue; // both inside = nesting; neither = disjoint or fully swallowed
      try {
        if (startInside) range.setStartBefore(mark);
        if (endInside) range.setEndAfter(mark);
        changed = true;
      } catch (e) {
        // Leave the range as-is if it can't be widened safely here.
      }
    }
  }
}

// Removes every existing mark for this qid/type on a page, merging text nodes back together for a clean re-highlight.
function unwrapMarksForQuestion(pageBody, qid, type) {
  const marks = pageBody.querySelectorAll(`mark[data-qid~="${qid}"][data-snippet-type="${type}"]`);
  marks.forEach(mark => {
    // A shared mark can't just be deleted for one qid — another duplicate-related question may rely on it. Drop qid from
    // the list; only unwrap/delete when the list would end up empty.
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

// Backstop: removes any <mark data-qid> that is completely empty (whitespace-only), the signature of an extractContents clone shell.
function dedupeMarks(container) {
  Array.from(container.querySelectorAll('mark[data-qid]')).forEach(mark => {
    if (!mark.textContent || !mark.textContent.trim()) {
      const parent = mark.parentNode;
      if (parent) parent.removeChild(mark);
    }
  });
  container.normalize();
}

// True if this qid/type currently has a similarity-fallback ("best guess") mark on the page rather than an exact one.
function hasFuzzyMark(pageBody, qid, type) {
  return !!pageBody.querySelector(`mark[data-qid~="${qid}"][data-snippet-type="${type}"][data-fuzzy="true"]`);
}

// Total whitespace-normalized length of whatever's currently marked for this qid/type on the page.
function markedTextLength(pageBody, qid, type) {
  const marks = pageBody.querySelectorAll(`mark[data-qid~="${qid}"][data-snippet-type="${type}"]`);
  let text = '';
  marks.forEach(m => { text += m.textContent; });
  return normalizeWhitespace(text).length;
}

// Sørensen-Dice bigram similarity, 0 to 1, used as a last-resort fallback when a snippet no longer appears verbatim.
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

// Splits a page's rendered text into candidate sentences for the similarity scan above.
function extractSentences(text) {
  return (text || '').split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 10);
}

// Minimum similarity (0-1) a fallback sentence must reach before the ladder accepts it as a stand-in match.
const SIMILARITY_FALLBACK_THRESHOLD = 0.4;

const SLOT_TYPES = ['source', 'question', 'answer'];

function snippetOfSlot(q, type) {
  return type === 'source' ? q.sourceSnippet : type === 'question' ? q.questionSnippet : q.answerSnippet;
}

function occurrenceOfSlot(q, type) {
  const n = type === 'source' ? q.sourceOccurrence : type === 'question' ? q.questionOccurrence : q.answerOccurrence;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function bodyForPage(docContainer, pageNum) {
  return docContainer.querySelector(`.doc-page[data-page="${pageNum}"] .doc-page-body`);
}

// Best sentence-similarity candidate for `snippet` inside a page body (optionally limited to a scope range).
function bestSentenceInBody(body, scope, snippet) {
  const { normalized } = buildNormalizedContainerIndex(body);
  const lo = scope ? scope.startIdx : 0;
  const hi = scope ? scope.endIdx : normalized.length;
  let best = null;
  extractSentences(normalized.slice(lo, hi)).forEach(sentence => {
    const score = calculateSimilarity(sentence, snippet);
    if (!best || score > best.score) best = { score, sentence };
  });
  return best;
}

// Locates one slot ('source' | 'question' | 'answer') of question q in the rendered pages, drawing its mark(s).
// `ctx` is a per-question object ({ source, question }) that carries each resolved slot's { pageNum, startIdx, endIdx }
// forward so children are searched only inside their parents. `ownPageVerifyTier` is the tier recorded on a stated-page find.
//   source:   own page -> doc-wide fuzzy sentence similarity -> raw answer/target-term only
//   question: inside the resolved source -> fuzzy sentence inside the source only -> not found
//   answer (inside):  inside question -> inside source -> fuzzy inside source -> not found (never page-wide)
//   answer (outside): answerPage -> fuzzy on answerPage -> any other page of the file (nearest preceding first) -> not found
// Returns { verifyTier, pageNum, score } (score only for a fuzzy match), or null if not located.
function locateAndHighlightSnippet(docContainer, q, type, ownPageVerifyTier, ctx) {
  const snippet = snippetOfSlot(q, type);
  if (!snippet) return null;
  ctx = ctx || {};
  const occurrence = occurrenceOfSlot(q, type);

  if (type === 'source') {
    unwrapMarksForQuestion(docContainer, q.id, 'source');
    const ownBody = bodyForPage(docContainer, q.sourcePage);
    if (ownBody) {
      const r = highlightSnippetInContainer(ownBody, snippet, q.id, 'source', q.tier, ownPageVerifyTier, { occurrence });
      if (r) {
        ctx.source = { pageNum: q.sourcePage, startIdx: r.startIdx, endIdx: r.endIdx };
        return { verifyTier: ownPageVerifyTier, pageNum: q.sourcePage, score: null };
      }
    }

    // Rung 3 — document-wide fuzzy sentence-similarity scan.
    let best = null; // { score, sentence, pageNum, body }
    docContainer.querySelectorAll('.doc-page').forEach(pageEl => {
      const body = pageEl.querySelector('.doc-page-body');
      if (!body) return;
      const cand = bestSentenceInBody(body, null, snippet);
      if (cand && (!best || cand.score > best.score)) best = { ...cand, pageNum: Number(pageEl.dataset.page), body };
    });
    if (best && best.score >= SIMILARITY_FALLBACK_THRESHOLD) {
      const r = highlightSnippetInContainer(best.body, best.sentence, q.id, 'source', q.tier, 3);
      if (r) {
        ctx.source = { pageNum: best.pageNum, startIdx: r.startIdx, endIdx: r.endIdx };
        return { verifyTier: 3, pageNum: best.pageNum, score: best.score };
      }
    }

    // Rung 4 — last resort: is the raw answer/target term itself findable anywhere at all?
    const termNeedle = q.targetTerm || q.answerSnippet || '';
    const termPage = termNeedle
      ? state.pages.find(p => fuzzyIncludes(cleanExtractedText(p.text), termNeedle))
      : null;
    if (termPage) {
      const termBody = bodyForPage(docContainer, termPage.pageNumber);
      const r = termBody ? highlightSnippetInContainer(termBody, termNeedle, q.id, 'source', q.tier, 4) : null;
      if (r) {
        ctx.source = { pageNum: termPage.pageNumber, startIdx: r.startIdx, endIdx: r.endIdx };
        return { verifyTier: 4, pageNum: termPage.pageNumber, score: null };
      }
    }
    return null;
  }

  if (type === 'question') {
    unwrapMarksForQuestion(docContainer, q.id, 'question');
    if (!ctx.source) return null;
    const body = bodyForPage(docContainer, ctx.source.pageNum);
    if (!body) return null;
    const scope = { startIdx: ctx.source.startIdx, endIdx: ctx.source.endIdx };
    let r = highlightSnippetInContainer(body, snippet, q.id, 'question', q.tier, ownPageVerifyTier, { scope, occurrence });
    if (r) {
      ctx.question = { pageNum: ctx.source.pageNum, startIdx: r.startIdx, endIdx: r.endIdx };
      return { verifyTier: ownPageVerifyTier, pageNum: ctx.source.pageNum, score: null };
    }
    const cand = bestSentenceInBody(body, scope, snippet);
    if (cand && cand.score >= SIMILARITY_FALLBACK_THRESHOLD) {
      r = highlightSnippetInContainer(body, cand.sentence, q.id, 'question', q.tier, 3, { scope });
      if (r) {
        ctx.question = { pageNum: ctx.source.pageNum, startIdx: r.startIdx, endIdx: r.endIdx };
        return { verifyTier: 3, pageNum: ctx.source.pageNum, score: cand.score };
      }
    }
    return null;
  }

  // type === 'answer'
  unwrapMarksForQuestion(docContainer, q.id, 'answer');

  if (q.answerScope === 'outside') {
    const answerPage = q.answerPage != null ? q.answerPage : q.sourcePage;
    const ownBody = bodyForPage(docContainer, answerPage);
    if (ownBody) {
      let r = highlightSnippetInContainer(ownBody, snippet, q.id, 'answer', q.tier, ownPageVerifyTier, { occurrence });
      if (r) return { verifyTier: ownPageVerifyTier, pageNum: answerPage, score: null };
      const cand = bestSentenceInBody(ownBody, null, snippet);
      if (cand && cand.score >= SIMILARITY_FALLBACK_THRESHOLD) {
        r = highlightSnippetInContainer(ownBody, cand.sentence, q.id, 'answer', q.tier, 3);
        if (r) return { verifyTier: 3, pageNum: answerPage, score: cand.score };
      }
    }
    // Any other page of the active file: nearest preceding page first, then following pages.
    const pageNums = Array.from(docContainer.querySelectorAll('.doc-page')).map(el => Number(el.dataset.page));
    const preceding = pageNums.filter(n => n < answerPage).sort((a, b) => b - a);
    const following = pageNums.filter(n => n > answerPage).sort((a, b) => a - b);
    for (const n of [...preceding, ...following]) {
      const body = bodyForPage(docContainer, n);
      const r = body ? highlightSnippetInContainer(body, snippet, q.id, 'answer', q.tier, 3) : null;
      if (r) return { verifyTier: 3, pageNum: n, score: null };
    }
    return null;
  }

  // Inside scope: question range first, then source range — never page-wide.
  const parents = [ctx.question, ctx.source].filter(Boolean);
  if (!parents.length) return null;
  const body = bodyForPage(docContainer, parents[0].pageNum);
  if (!body) return null;
  for (const p of parents) {
    const r = highlightSnippetInContainer(body, snippet, q.id, 'answer', q.tier, ownPageVerifyTier,
      { scope: { startIdx: p.startIdx, endIdx: p.endIdx }, occurrence });
    if (r) return { verifyTier: ownPageVerifyTier, pageNum: p.pageNum, score: null };
  }
  if (ctx.source) {
    const scope = { startIdx: ctx.source.startIdx, endIdx: ctx.source.endIdx };
    const cand = bestSentenceInBody(body, scope, snippet);
    if (cand && cand.score >= SIMILARITY_FALLBACK_THRESHOLD) {
      const r = highlightSnippetInContainer(body, cand.sentence, q.id, 'answer', q.tier, 3, { scope });
      if (r) return { verifyTier: 3, pageNum: ctx.source.pageNum, score: cand.score };
    }
  }
  return null;
}

// Note text shared by the batch and single-question rechecks for a located slot.
function pageNoteFor(q, type, located) {
  const stated = (type === 'answer' && q.answerScope === 'outside' && q.answerPage != null) ? q.answerPage : q.sourcePage;
  return located.pageNum !== stated ? ` (found on p.${located.pageNum}, not its stated p.${stated})` : '';
}

const SLOT_LABEL = { source: 'source', question: 'question', answer: 'answer' };

// Batch recheck: rebuilds every question's highlights fresh via renderTextVersion() and reconciles verifyTier/
// sourceFound/questionFound/answerFound bookkeeping and the status message from what that rebuild's ladder found per slot.
// Never touches importance (q.tier); updates q.verifyTier to the worst of a question's slot results this pass.
function recheckHighlights() {
  if (state.questions.length === 0) {
    setSelectionGenStatus('No questions to check.', 'error');
    setTimeout(() => setSelectionGenStatus(''), 2500);
    return;
  }

  const results = renderTextVersion();

  let ok = 0; // Tier 1 — exact/near-exact own-page match this pass.
  let fuzzyMatched = 0; // Tier 3 — fuzzy-sentence fallback.
  let unclassifiedCount = 0; // Tier 4 — term-only fallback.
  const stillMissing = [];
  const fuzzyNotes = [];
  const unclassifiedNotes = [];

  state.questions.forEach((q, i) => {
    // Pane 2 only shows the active source's pages this session — a question from another source has nothing in the
    // DOM to be rechecked against, so leave its verifyTier/found flags as-is and skip it.
    if (q.sourceId !== state.activeSourceId) return;

    const label = 'Q' + String(i + 1).padStart(2, '0');
    const entry = results.get(q.id) || { source: null, question: null, answer: null };
    const slotTiers = []; // this question's tier(s) actually checked this pass

    SLOT_TYPES.forEach((type) => {
      if (!snippetOfSlot(q, type)) return; // nothing to check for this slot

      const located = entry[type];
      if (type === 'source') q.sourceFound = !!located;
      else if (type === 'question') q.questionFound = !!located;
      else q.answerFound = !!located;

      if (!located) {
        slotTiers.push(4);
        stillMissing.push({
          label, type,
          reason: type === 'source'
            ? `text (and its answer/target term) no longer matches anywhere in the document`
            : `not found inside ${type === 'question' ? 'its source snippet' : (q.answerScope === 'outside' ? 'the document' : 'its source snippet')}`,
        });
        return;
      }

      slotTiers.push(located.verifyTier);
      if (located.verifyTier === 1) {
        ok++;
      } else if (located.verifyTier === 3) {
        fuzzyMatched++;
        fuzzyNotes.push({
          label, type,
          reason: `no exact match — highlighted the closest sentence instead (${Math.round((located.score || 0) * 100)}% similar)${pageNoteFor(q, type, located)}; please verify it's correct`,
        });
      } else if (located.verifyTier === 4) {
        unclassifiedCount++;
        const pageNote = located.pageNum !== q.sourcePage ? ` on p.${located.pageNum}` : '';
        unclassifiedNotes.push({
          label, type,
          reason: `context snippet not found anywhere — only the answer/target term was located${pageNote}`,
        });
      } else {
        ok++; // tier 2 can't come out of the batch pass (it always passes 1), but never drop a located slot silently
      }
    });

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

  logAllHighlights('end of recheckHighlights (batch)');
}

recheckHighlightsBtn.addEventListener('click', recheckHighlights);

// True if this slot already has exact (non-fuzzy) marks of reasonable length on the right page, nested inside the
// right parent mark(s) of the same question — the "already fine" shortcut used by the single-question recheck.
function slotAlreadyFine(q, type) {
  const snippet = snippetOfSlot(q, type);
  const expectedLen = normalizeWhitespace(snippet).length;
  const pageNum = (type === 'answer' && q.answerScope === 'outside' && q.answerPage != null) ? q.answerPage : q.sourcePage;
  const body = bodyForPage(docTextContainer, pageNum);
  if (!body || expectedLen === 0) return false;
  if (hasFuzzyMark(body, q.id, type) || markedTextLength(body, q.id, type) < expectedLen * 0.4) return false;

  const parentTypes = type === 'question' ? ['source']
    : (type === 'answer' && q.answerScope !== 'outside') ? ['question', 'source']
    : null;
  if (!parentTypes) return true;
  const marks = body.querySelectorAll(`mark[data-qid~="${q.id}"][data-snippet-type="${type}"]`);
  return Array.from(marks).every(m =>
    parentTypes.some(pt => m.closest(`mark[data-snippet-type="${pt}"][data-qid~="${q.id}"]`))
  );
}

// Single-question version of recheckHighlights: same three-slot ladder, scoped to one question. Backs the per-question
// recheck so a single edit doesn't require a full document-wide recheck. { force: true } skips the "already fine" shortcut
// (used after a snippet was replaced, when existing marks may be stale even though they look plausible).
function recheckHighlightsForQuestion(qid, opts) {
  const force = !!(opts && opts.force);
  const q = state.questions.find(x => x.id === qid);
  if (!q) return;

  // Pane 2 only shows the active source's pages this session — a question from a different source has nothing to search.
  if (q.sourceId !== state.activeSourceId) {
    setSelectionGenStatus('This question belongs to a different imported document — switch to it in Pane 3 to recheck its highlight.', 'error');
    setTimeout(() => setSelectionGenStatus(''), 3500);
    return;
  }

  const slots = SLOT_TYPES.filter(t => snippetOfSlot(q, t));
  if (slots.length === 0) {
    setSelectionGenStatus('This question has no source/question/answer snippet to check yet.', 'error');
    setTimeout(() => setSelectionGenStatus(''), 2500);
    return;
  }

  const setFound = (type, val) => {
    if (type === 'source') q.sourceFound = val;
    else if (type === 'question') q.questionFound = val;
    else q.answerFound = val;
  };

  let worstTier = 1;
  const notes = [];

  if (!force && slots.every(t => slotAlreadyFine(q, t))) {
    slots.forEach(t => { setFound(t, true); notes.push(`${SLOT_LABEL[t]}: already fine`); });
  } else {
    const ctx = {};
    // Clear all three slots up front so a stale mark of this question can't widen a fresh parent mark drawn below.
    SLOT_TYPES.forEach(t => unwrapMarksForQuestion(docTextContainer, q.id, t));
    SLOT_TYPES.forEach((type) => {
      if (!snippetOfSlot(q, type)) return;
      const located = locateAndHighlightSnippet(docTextContainer, q, type, 2, ctx);
      if (located) {
        worstTier = Math.max(worstTier, located.verifyTier);
        setFound(type, true);
        if (located.verifyTier <= 2) {
          notes.push(`${SLOT_LABEL[type]}: ${located.verifyTier === 2 ? 'relocated' : 'found'}${pageNoteFor(q, type, located)}`);
        } else if (located.verifyTier === 3) {
          notes.push(`${SLOT_LABEL[type]}: no exact match — closest match used instead${located.score != null ? ` (${Math.round(located.score * 100)}% similar)` : ''}${pageNoteFor(q, type, located)}, please verify`);
        } else {
          const pageNote = located.pageNum !== q.sourcePage ? ` on p.${located.pageNum}` : '';
          notes.push(`${SLOT_LABEL[type]}: context not found anywhere — only the answer/target term was located${pageNote}`);
        }
        return;
      }
      worstTier = Math.max(worstTier, 4);
      setFound(type, false); // genuinely un-highlightable — this is what makes a question "Unverified"
      notes.push(`${SLOT_LABEL[type]}: not found${type === 'source' ? ' anywhere in the document' : (type === 'answer' && q.answerScope === 'outside' ? ' in the document' : ' inside its source snippet')}`);
    });
    q.verifyTier = worstTier;
  }

  renderQuestionNav();
  if (state.activeCardId === qid) renderActiveQuestion();
  syncMarkActiveAndUncheckedState(state.activeCardId);

  // Defensive backstop only — see dedupeMarks' header comment.
  dedupeMarks(docTextContainer);

  console.info(`Recheck (single question ${qid}):`, notes);
  setSelectionGenStatus(notes.join(' · '), worstTier >= 3 ? 'error' : 'success');
  setTimeout(() => setSelectionGenStatus(''), 4000);
}

function logAllHighlights(label) {
  const marks = Array.from(docTextContainer.querySelectorAll('mark[data-qid]'));
  const byQid = {};
  marks.forEach(m => {
    const type = m.dataset.snippetType; // 'source' | 'question' | 'answer'
    const pageEl = m.closest('.doc-page');
    const page = pageEl ? pageEl.dataset.page : null;
    // A shared mark carries more than one qid — attribute it to every question it belongs to.
    markQidList(m).forEach(qid => {
      if (!byQid[qid]) byQid[qid] = { source: 0, question: 0, answer: 0, entries: [] };
      if (type === 'source' || type === 'question' || type === 'answer') byQid[qid][type] += 1;
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
    if (q.sourceId !== state.activeSourceId) return;

    const marksForQ = byQid[q.id] || { source: 0, question: 0, answer: 0 };
    SLOT_TYPES.forEach((type) => {
      const snippet = snippetOfSlot(q, type);
      if (snippet && marksForQ[type] === 0) {
        missing.push({ qid: q.id, type, sourcePage: q.sourcePage, snippetPreview: snippet.slice(0, 60) });
      }
    });
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
  findMatchesInIndex,
  findSnippetRange,
  selectionRangeIdx,
  computeOccurrenceIndex,
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
  markQidList,
  markHasQid,
  areDuplicateQids,
};
