// doc-extraction.js
// Extracts page text from PDF (pdf.js + Tesseract OCR fallback) and PPTX (JSZip + slide XML parse).
// Uses globals Tesseract, pdfjsLib, JSZip, DOMParser directly (loaded via separate <script> tags, no import).

import { state } from './core-state.js';
import { setParseStatus } from './status-helpers.js';

// OCRs a rendered PDF page via Tesseract when the page has no extractable text layer.
async function ocrPdfPage(page) {
  const scale = 1.5;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  const { data } = await Tesseract.recognize(canvas, 'eng');
  return (data && data.text) || '';
}

// Groups pdf.js text items into visual lines using their y-position, so paragraph/line breaks survive extraction.
function groupTextItemsIntoLines(items) {
  if (!items || items.length === 0) return '';
  const Y_TOLERANCE = 3;
  const rows = [];
  items.forEach(it => {
    if (!it.str) return;
    const y = it.transform[5];
    const x = it.transform[4];
    let row = rows.find(r => Math.abs(r.y - y) <= Y_TOLERANCE);
    if (!row) { row = { y, items: [] }; rows.push(row); }
    row.items.push({ x, str: it.str });
  });
  rows.sort((a, b) => b.y - a.y); // PDF y grows upward -> top-to-bottom
  return rows
    .map(r => r.items.sort((a, b) => a.x - b.x).map(i => i.str).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// Extracts per-page text from a PDF file, falling back to OCR for pages with no text layer.
async function extractPdfPages(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  state.pdfDoc = pdf;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let text = groupTextItemsIntoLines(content.items);

    if (!text.trim()) {
      setParseStatus(`OCR is scanning page ${i}…`);
      text = await ocrPdfPage(page);
    }

    pages.push({ pageNumber: i, text });
  }
  return pages;
}

// Walks <a:p> paragraphs so bullet markers and bold/italic runs survive as markdown-lite text with real line breaks.
function extractTextFromSlideXml(xml) {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const paragraphs = doc.getElementsByTagName('a:p');
    const lines = [];
    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      const isBullet = !!(p.getElementsByTagName('a:buChar').length || p.getElementsByTagName('a:buAutoNum').length);
      const runs = p.getElementsByTagName('a:r');
      let lineText = '';
      for (let j = 0; j < runs.length; j++) {
        const r = runs[j];
        const tEl = r.getElementsByTagName('a:t')[0];
        if (!tEl) continue;
        let runText = tEl.textContent || '';
        if (!runText) continue;
        const rPr = r.getElementsByTagName('a:rPr')[0];
        const bold = rPr && rPr.getAttribute('b') === '1';
        const italic = rPr && rPr.getAttribute('i') === '1';
        if (bold) runText = `**${runText}**`;
        if (italic) runText = `*${runText}*`;
        lineText += runText;
      }
      lineText = lineText.trim();
      if (!lineText) continue;
      lines.push(isBullet ? `• ${lineText}` : lineText);
    }
    if (lines.length === 0) {
      // Fallback for slides without recognizable <a:p> structure.
      const nodes = doc.getElementsByTagName('a:t');
      const parts = [];
      for (let i = 0; i < nodes.length; i++) parts.push(nodes[i].textContent);
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    }
    return lines.join('\n');
  } catch (e) {
    return '';
  }
}

// Unzips a PPTX, extracts each slide's text, and caches the file/zip on state for the renderer tiers to use.
async function extractPptxPages(file) {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  state.pptxFile = file; // used by pptx-render.js Tier 1
  state.pptxZip = zip;   // used by pptx-render.js Tier 2
  console.log('[doc-extraction] pptx state set', { fileName: file.name, hasZip: !!zip });

  const slidePaths = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p));
  slidePaths.sort((a, b) => {
    const na = parseInt(a.match(/slide(\d+)\.xml/)[1], 10);
    const nb = parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
    return na - nb;
  });
  const pages = [];
  for (const path of slidePaths) {
    const num = parseInt(path.match(/slide(\d+)\.xml/)[1], 10);
    const xml = await zip.file(path).async('string');
    pages.push({ pageNumber: num, text: extractTextFromSlideXml(xml) });
  }
  return pages;
}

export {
  ocrPdfPage,
  groupTextItemsIntoLines,
  extractPdfPages,
  extractTextFromSlideXml,
  extractPptxPages,
};
