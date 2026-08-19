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

// Locates `snippet` inside `container`'s rendered text and wraps it in one or more <mark data-qid="…"> elements without
// disturbing surrounding markup. `type` is 'question' (colored by `tier`) or 'answer' (always green). A match spanning
// block boundaries is split into one <mark> per block segment; silently no-ops if the snippet isn't present.
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

// importanceTier drives the mark's background color; verifyTier drives the separate V1-V4 badge — independent of each other.
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
    // Fallback: retry with punctuation stripped from both sides, translating the match back to `normalized` offsets.
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
    // Second fallback: a snippet naming a list vs. the same list reformatted as bullets with connectors dropped.
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

  groups.forEach(g => {
    try {
      const range = document.createRange();
      range.setStart(g.startNode, g.startOffset);
      range.setEnd(g.endNode, g.endOffset);

      // For a 'question' mark, check for an overlapping duplicate-related mark before the normal widen/extract/nest path.
      let extraQidsForNewMark = [];
      if (type === 'question') {
        const shareResult = tryShareDuplicateMark(container, range, qid);
        if (shareResult && shareResult.skip) return; // folded into an existing mark — no new <mark> needed
        if (shareResult && shareResult.extraIds) extraQidsForNewMark = shareResult.extraIds;
      }

      // Widen the range so any partially-overlapped <mark> becomes fully contained, so extractContents moves (not clones) it.
      widenRangeToAvoidPartialMarks(container, range);
      const mark = document.createElement('mark');
      mark.className = cssClass;
      mark.dataset.qid = extraQidsForNewMark.length
        ? Array.from(new Set([...extraQidsForNewMark, qid])).join(' ')
        : qid;
      mark.dataset.snippetType = type === 'answer' ? 'answer' : 'question';
      mark.dataset.tier = String(resolvedVerify);
      if (resolvedVerify >= 3) mark.dataset.fuzzy = 'true';
      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);

      // Un-nest any duplicate-related mark the widen step above may have nested inside `mark`.
      if (type === 'question') mergeNestedDuplicateMarks(mark, qid);
    } catch (e) {
      console.warn('highlightSnippetInContainer: a matched segment could not be wrapped and was skipped', { qid, type, snippet });
    }
  });
}

// Widens `range` in place so no existing <mark data-qid> is left partially inside it; runs to a fixed point.
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
        continue; // mark isn't a valid selectable node — skip it
      }

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

// Minimum similarity (0-1) a fallback sentence must reach before recheckHighlights accepts it as a stand-in match.
const SIMILARITY_FALLBACK_THRESHOLD = 0.4;

// Shared per-slot location ladder: own-page attempt -> document-wide fuzzy sentence-similarity scan -> raw
// answer/target-term-only fallback. `ownPageVerifyTier` is the tier to record on an own-page find. Returns
// `{ verifyTier, pageNum, score }` (score only set for a Tier 3 fuzzy match), or null if not located anywhere.
function locateAndHighlightSnippet(docContainer, q, type, ownPageVerifyTier) {
  const snippet = type === 'answer' ? q.answerSnippet : q.sourceSnippet;
  if (!snippet) return null;
  const expectedLen = normalizeWhitespace(snippet).length;
  const pageBody = docContainer.querySelector(`.doc-page[data-page="${q.sourcePage}"] .doc-page-body`);

  // Rung 1/2 — own stated page.
  if (pageBody) {
    unwrapMarksForQuestion(pageBody, q.id, type);
    highlightSnippetInContainer(pageBody, snippet, q.id, type, q.tier, ownPageVerifyTier);
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

  // Rung 4 — last resort: is the raw answer/target term itself findable anywhere at all?
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

// Batch recheck: rebuilds every question's highlight fresh via renderTextVersion() and reconciles verifyTier/
// sourceFound/answerFound bookkeeping and the status message from what that rebuild's ladder found per question/slot.
// Never touches importance (q.tier); updates q.verifyTier to the worse of a question's slot results this pass.
function recheckHighlights() {
  if (state.questions.length === 0) {
    setSelectionGenStatus('No questions to check.', 'error');
    setTimeout(() => setSelectionGenStatus(''), 2500);
    return;
  }

  const results = renderTextVersion();

  let ok = 0; // Tier 1 — exact/near-exact own-page match this pass.
  let fuzzyMatched = 0; // Tier 3 — doc-wide similarity fallback.
  let unclassifiedCount = 0; // Tier 4 — term-only fallback.
  const stillMissing = [];
  const fuzzyNotes = [];
  const unclassifiedNotes = [];

  state.questions.forEach((q, i) => {
    // Pane 2 only shows the active source's pages this session — a question from another source has nothing in the
    // DOM to be rechecked against, so leave its verifyTier/sourceFound/answerFound as-is and skip it.
    if (q.sourceId !== state.activeSourceId) return;

    const label = 'Q' + String(i + 1).padStart(2, '0');
    const entry = results.get(q.id) || { question: null, answer: null };
    const slotTiers = []; // this question's tier(s) actually checked this pass

    [
      { type: 'question', snippet: q.sourceSnippet },
      { type: 'answer', snippet: q.answerSnippet },
    ].forEach(({ type, snippet }) => {
      if (!snippet) return; // nothing to check for this slot

      const located = entry[type];
      if (type === 'question') q.sourceFound = !!located;
      else q.answerFound = !!located;

      if (!located) {
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

// Single-question version of recheckHighlights: same location ladder, scoped to one question. Backs the per-question
// "🔎 Recheck this question" button, so a single edit doesn't require a full document-wide recheck.
function recheckHighlightsForQuestion(qid) {
  const q = state.questions.find(x => x.id === qid);
  if (!q) return;

  // Pane 2 only shows the active source's pages this session — a question from a different source has nothing to search.
  if (q.sourceId !== state.activeSourceId) {
    setSelectionGenStatus('This question belongs to a different imported document — switch to it in Pane 3 to recheck its highlight.', 'error');
    setTimeout(() => setSelectionGenStatus(''), 3500);
    return;
  }

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
  const found = {};

  slots.forEach(({ snippet, type }) => {
    const ownPageBody = docTextContainer.querySelector(`.doc-page[data-page="${q.sourcePage}"] .doc-page-body`);
    const expectedLen = normalizeWhitespace(snippet).length;

    if (ownPageBody) {
      const existingLen = markedTextLength(ownPageBody, q.id, type);
      if (!hasFuzzyMark(ownPageBody, q.id, type) && expectedLen > 0 && existingLen >= expectedLen * 0.4) {
        notes.push(`${type}: already fine`);
        found[type] = true;
        return; // worstTier stays at whatever it already was — this slot is confirmed
      }
    }

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
    const type = m.dataset.snippetType; // 'question' | 'answer'
    const pageEl = m.closest('.doc-page');
    const page = pageEl ? pageEl.dataset.page : null;
    // A shared mark carries more than one qid — attribute it to every question it belongs to.
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
    if (q.sourceId !== state.activeSourceId) return;

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
  markQidList,
  markHasQid,
  areDuplicateQids,
};
