// text-normalize.js
// Extracted verbatim from online-quiz-maker.html, source lines 1813-1961.
// Function/const bodies are UNCHANGED from source — only import/export
// wrapper lines were added.
//
// NOTE: SNIPPET_PUNCTUATION_RE (source line 1905) is also used directly
// by highlighting.js (source lines 2190, 2194, inside
// stripPunctuationKeepMap) — it's exported from here rather than
// duplicated there, since this is where it's originally declared.

import { escapeHtml } from './editor-render.js';

// ---------------------------------------------------------------------
// Verbatim from source, lines 1813-1817
// ---------------------------------------------------------------------
function renderInlineMarkdown(escapedText) {
  return escapedText
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

// A short, title-like line is treated as a heading rather than folded
// into the surrounding paragraph: ALL-CAPS labels, or short lines that
// end with a colon (section labels), are the two reliable signals OCR
// line-splitting still preserves.
// ---------------------------------------------------------------------
// Verbatim from source, lines 1823-1828
// ---------------------------------------------------------------------
function isLikelyHeading(line) {
  if (!line || line.length > 70) return false;
  const letters = line.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && letters === letters.toUpperCase()) return true;
  if (/:$/.test(line) && line.length <= 70 && !/[.!?]\s*:$/.test(line)) return true;
  return false;
}

// Joins consecutive wrapped lines of a paragraph back into one flowing
// run of text, repairing mid-word OCR hyphenation ("Oracle sys-" +
// "tems" -> "Oracle systems") instead of leaving a hard break.
// ---------------------------------------------------------------------
// Verbatim from source, lines 1834-1845
// ---------------------------------------------------------------------
function mergeParagraphLines(lines) {
  let result = '';
  lines.forEach((line, i) => {
    if (i === 0) { result = line; return; }
    if (/[A-Za-z]-$/.test(result)) {
      result = result.slice(0, -1) + line;
    } else {
      result += ' ' + line;
    }
  });
  return result.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 1847-1884
// ---------------------------------------------------------------------
function renderPageTextHtml(text) {
  const lines = (text || '').split('\n');
  let html = '';
  let inList = false;
  let paraBuffer = [];

  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  const flushParagraph = () => {
    if (paraBuffer.length === 0) return;
    html += `<p>${renderInlineMarkdown(escapeHtml(mergeParagraphLines(paraBuffer)))}</p>`;
    paraBuffer = [];
  };

  lines.forEach(rawLine => {
    const line = rawLine.trim();
    // Blank line = explicit section break: close out whatever paragraph
    // or list was in progress.
    if (!line) { flushParagraph(); closeList(); return; }

    const bulletMatch = line.match(/^(?:[•▪●◦‣∙*-]|\d+[.)])\s+(.*)$/);
    if (bulletMatch && bulletMatch[1]) {
      flushParagraph();
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${renderInlineMarkdown(escapeHtml(bulletMatch[1]))}</li>`;
      return;
    }

    closeList();

    if (isLikelyHeading(line)) {
      flushParagraph();
      html += `<p class="doc-heading">${renderInlineMarkdown(escapeHtml(line))}</p>`;
      return;
    }

    // Ordinary wrapped line — accumulate into the running paragraph
    // instead of emitting its own <p>.
    paraBuffer.push(line);
  });
  flushParagraph();
  closeList();
  return html || '<p class="text-mute italic">(no extractable text on this page)</p>';
}

// ---------- Normalized whitespace matching ----------
// AI-returned snippets often differ from the source only in
// incidental whitespace (a line break where the rendered text has a
// space, doubled spaces, etc.). This matcher collapses whitespace to
// single spaces for both the source and the snippet, then maps the
// normalized match back to exact original offsets.
// ---------------------------------------------------------------------
// Verbatim from source, lines 1897-1899
// ---------------------------------------------------------------------
function normalizeWhitespace(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

// Punctuation the AI/OCR pipeline most commonly disagrees on even when
// the underlying wording is identical (curly vs. straight quotes, an
// inserted/dropped comma, hyphen vs. en/em-dash, etc.) — used as a
// fallback match pass when an exact whitespace-normalized match fails.
// ---------------------------------------------------------------------
// Verbatim from source, lines 1905-1908
// ---------------------------------------------------------------------
const SNIPPET_PUNCTUATION_RE = /[.,;:!?"'`\u2018\u2019\u201C\u201D()\[\]{}\-–—…/\\]/g;
function stripPunctuationForMatch(str) {
  return (str || '').replace(SNIPPET_PUNCTUATION_RE, '');
}

// A prose snippet that names a list (e.g. "Input devices, Output
// devices, Storage devices, and Communication devices") almost always
// stops reading as the SAME text once that list gets reformatted into
// bullets — the rendered bullets drop the comma/"and" connectors
// entirely ("Input devices" / "Output devices" / ... each its own
// <li>), so even the punctuation-stripped fallback above still fails
// on the lone leftover word "and" (or "or"). This strips standalone
// list-conjunction words (never mid-word — "sandbox" must survive) on
// top of the punctuation strip, as one more fallback pass before a
// snippet spanning a bulleted enumeration is given up on as
// "genuinely not present".
// ---------------------------------------------------------------------
// Verbatim from source, lines 1921-1923
// ---------------------------------------------------------------------
function stripListConjunctionsForMatch(str) {
  return stripPunctuationForMatch(str).replace(/\b(?:and|or)\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

// Key used to compare/deduplicate targetTerms across passes and against
// the extension registry. Plain .toLowerCase() alone is NOT enough:
// the AI frequently returns the "same" term with a trailing period, a
// curly vs. straight quote/apostrophe, an en/em-dash vs. hyphen, or
// stray whitespace from one pass to the next. Those cosmetic
// differences made an already-covered term look "new" to the
// exclusion-list/registry lookups below, which is why repeat
// questions kept slipping through even though the term had already
// been generated. Reuses the same punctuation-stripping used for
// snippet-highlight matching so both dedup paths agree on what counts
// as "the same text".
// ---------------------------------------------------------------------
// Verbatim from source, lines 1936-1938
// ---------------------------------------------------------------------
function normalizeTermKey(term) {
  return stripPunctuationForMatch(normalizeWhitespace(term)).toLowerCase();
}

// Light, dependency-free singularizer applied to the LAST word of an
// already-normalized (lowercase, punctuation-stripped) term key. Exists
// because the AI's own cross-pass exclusion prompt is text-based — it
// relies on the model recognizing "Input Devices" (Tier 2) as the same
// concept it already minted as "Input Device" (Tier 1), and it doesn't
// always catch that. This never claims to be a real linguistic
// singularizer; it only needs to collapse the handful of common plain
// -s/-es/-ies plurals that actually show up in these terms, without
// false-positiving on words that just happen to end in "s" (skips
// anything 3 chars or shorter, and anything already ending "ss").
// ---------------------------------------------------------------------
// Verbatim from source, lines 1950-1961
// ---------------------------------------------------------------------
function lightSingularizeKey(key) {
  const parts = key.split(' ');
  const last = parts[parts.length - 1];
  if (last.length > 3) {
    if (/[^aeiou]ies$/.test(last)) parts[parts.length - 1] = last.slice(0, -3) + 'y';
    else if (/(?:s|x|z|ch|sh)es$/.test(last)) parts[parts.length - 1] = last.slice(0, -2);
    else if (/[^s]s$/.test(last)) parts[parts.length - 1] = last.slice(0, -1);
  }
  return parts.join(' ');
}
function normalizeTermKeyLoose(term) {
  return lightSingularizeKey(normalizeTermKey(term));
}

export {
  renderInlineMarkdown,
  isLikelyHeading,
  mergeParagraphLines,
  renderPageTextHtml,
  normalizeWhitespace,
  SNIPPET_PUNCTUATION_RE,
  stripPunctuationForMatch,
  stripListConjunctionsForMatch,
  normalizeTermKey,
  lightSingularizeKey,
  normalizeTermKeyLoose,
};
