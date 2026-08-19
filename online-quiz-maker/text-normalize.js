import { escapeHtml } from './editor-render.js';

function renderInlineMarkdown(escapedText) {
  return escapedText
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

// Flags a line as a heading if it's short and ALL-CAPS, or short and ends with a colon.
function isLikelyHeading(line) {
  if (!line || line.length > 70) return false;
  const letters = line.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && letters === letters.toUpperCase()) return true;
  if (/:$/.test(line) && line.length <= 70 && !/[.!?]\s*:$/.test(line)) return true;
  return false;
}

// Joins wrapped paragraph lines into one run of text, repairing mid-word OCR hyphenation.
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
    // Blank line = explicit section break: close out any open paragraph or list.
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

    // Ordinary wrapped line — accumulate into the running paragraph instead of emitting its own <p>.
    paraBuffer.push(line);
  });
  flushParagraph();
  closeList();
  return html || '<p class="text-mute italic">(no extractable text on this page)</p>';
}

// Collapses whitespace to single spaces so AI-returned snippets match source text despite incidental whitespace differences.
function normalizeWhitespace(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

// Punctuation chars the AI/OCR pipeline commonly disagrees on; stripped as a fallback match pass when exact matching fails.
const SNIPPET_PUNCTUATION_RE = /[.,;:!?"'`\u2018\u2019\u201C\u201D()\[\]{}\-–—…/\\]/g;
function stripPunctuationForMatch(str) {
  return (str || '').replace(SNIPPET_PUNCTUATION_RE, '');
}

// Strips standalone "and"/"or" on top of the punctuation strip, since bulleted lists drop those connectors.
function stripListConjunctionsForMatch(str) {
  return stripPunctuationForMatch(str).replace(/\b(?:and|or)\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

// Normalizes a term for dedup comparison, stripping cosmetic differences (punctuation, whitespace, case) that made repeat terms look new.
function normalizeTermKey(term) {
  return stripPunctuationForMatch(normalizeWhitespace(term)).toLowerCase();
}

// Lightly singularizes the last word of a normalized term key, so plural/singular variants of the same term dedup together.
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
