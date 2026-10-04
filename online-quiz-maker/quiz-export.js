// --- Shared dependencies ---
import { state } from './core-state.js';
import { PBKDF2_ITERATIONS, SALT_LEN, IV_LEN } from './core-state.js';
import {
  quizTitleInput,
  exportJsonBtn,
  quizCodeBtn,
  closeModalBtn,
  secretKeyRow,
  secretKeyInput,
  combineKeyToggle,
  copySecretBtn,
  regenSecretBtn,
  generateCodeBtn,
  codeResultBox,
  quizCodeOutput,
  copyCodeBtn,
  downloadCodeBtn,
  modalError,
  quizCodeModal,
} from './dom-refs.js';

// Mints a stable lesson id for a source the first time it's exported, caching it on the source object itself so
// re-exporting the same Quiz Maker session (without reloading) reuses the same id every time. Kept separate from
// buildQuizObject() so swapping the ID scheme later (e.g. a content-derived id) doesn't touch its structure.
function getOrAssignLessonId(source) {
  if (!source.lessonId) {
    source.lessonId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : 'lesson_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
  return source.lessonId;
}

// builds the exportable quiz object (title + lessons + questions) from state. Each state.sources[] entry is
// promoted to a first-class "lesson" (formatVersion 2) so the Quiz Taker can group/report on questions by
// source file; a question added without ever importing a document exports with lessonId: null.
function buildQuizObject() {
  const lessons = state.sources.map((source, index) => ({
    id: getOrAssignLessonId(source),
    name: source.name,
    order: index,
  }));

  return {
    title: quizTitleInput.value.trim() || 'Untitled Quiz',
    formatVersion: 2,
    lessons,
    questions: state.questions.map(q => {
      const source = q.sourceId ? state.sources.find(s => s.id === q.sourceId) : null;
      return {
        id: q.id,
        lessonId: source ? getOrAssignLessonId(source) : null,
        targetTerm: q.targetTerm || '',
        sourcePage: q.sourcePage,
        sourceSnippet: q.sourceSnippet || '',
        questionSnippet: q.questionSnippet || '',
        answerSnippet: q.answerSnippet || '',
        // additive fields: answerPage null = same page as sourcePage; Taker ignores all three new keys
        answerPage: q.answerPage != null ? q.answerPage : null,
        answerScope: q.answerScope === 'outside' ? 'outside' : 'inside',
        tier: [1, 2, 3].includes(q.tier) ? q.tier : 1,
        definitionType: q.definitionType === 'extension' ? 'extension' : 'new',
        variants: q.variants.map(v => ({
          type: v.type,
          questionText: v.questionText,
          choices: v.choices,
          correctAnswerIndex: v.correctAnswerIndex,
          // Only present (and only meaningful) for 'category' variants —
          // omitted for every other type so exported JSON stays clean.
          ...(v.type === 'category' ? { correctAnswerIndices: v.correctAnswerIndices || [] } : {}),
        })),
      };
    }),
  };
}

// validates a quiz object has at least one question, each with valid variants and answers, before export.
// Confirmed (Batch B): doesn't reference sourceId/sourceName/lessons, so the formatVersion 2 shape needs no change here.
function validateQuiz(data) {
  if (!data || typeof data !== 'object') throw new Error('Quiz data is not a valid object.');
  if (!Array.isArray(data.questions) || data.questions.length === 0) throw new Error('Add at least one question first.');
  for (const q of data.questions) {
    if (!Array.isArray(q.variants) || q.variants.length === 0) {
      throw new Error('One or more question collections have no variants left — add at least one question type.');
    }
    for (const v of q.variants) {
      if (typeof v.questionText !== 'string' || !v.questionText.trim() ||
          !Array.isArray(v.choices) || v.choices.length === 0 ||
          v.choices.some(c => typeof c !== 'string' || !c.trim())) {
        throw new Error('One or more question variants are missing required fields.');
      }
      if (v.type === 'category') {
        if (!Array.isArray(v.correctAnswerIndices) || v.correctAnswerIndices.length === 0 ||
            v.correctAnswerIndices.some(i => typeof i !== 'number' || i < 0 || i >= v.choices.length)) {
          throw new Error('One or more Category Selection variants are missing correct answers.');
        }
      } else if (typeof v.correctAnswerIndex !== 'number' ||
          v.correctAnswerIndex < 0 || v.correctAnswerIndex >= v.choices.length) {
        throw new Error('One or more question variants are missing required fields.');
      }
    }
  }
  return true;
}

// exports the current quiz as a downloaded JSON file
function exportJson() {
  const quiz = buildQuizObject();
  console.log('Quiz JSON export:', quiz);

  const blob = new Blob([JSON.stringify(quiz, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const slug = quiz.title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'quiz';
  a.download = slug + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
exportJsonBtn.addEventListener('click', exportJson);

// ---------- Base64URL helpers ----------
// converts a byte buffer to a URL-safe base64 string (no padding)
function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// converts a URL-safe base64 string back to a byte buffer — inverse of bufferToBase64Url above
function base64UrlToBuffer(base64url) {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Combined Quiz Code format delimiter, between the base64url-encoded key and the base64url-encoded
// salt+iv+ciphertext. '.' is outside base64url's alphabet (A-Za-z0-9-_), and bufferToBase64Url's own
// char substitution (+→-, /→_, strip =) never introduces one either, so splitting on the first '.' is
// unambiguous and a legacy ciphertext-only code (no '.') is never mistaken for a combined one.
const QUIZ_CODE_KEY_DELIMITER = '.';

// ---------- Native gzip compression ----------
// gzip-compresses a string using the browser's CompressionStream API
async function gzipCompress(text) {
  if (typeof CompressionStream === 'undefined') throw new Error('This browser does not support CompressionStream.');
  const cs = new CompressionStream('gzip');
  const stream = new Blob([text]).stream().pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// ---------- Key derivation (PBKDF2 -> AES-GCM) ----------
// derives an AES-GCM encryption key from a secret key and salt via PBKDF2
async function deriveKey(secretKey, saltBytes) {
  if (!window.crypto || !window.crypto.subtle) throw new Error('This browser does not support the Web Crypto API.');
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(secretKey), { name: 'PBKDF2' }, false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Encrypts and encodes the quiz as a shareable Quiz Code string (PBKDF2 + AES-GCM + gzip + base64url).
// combineKeyWithCode (default true) prepends the secret key itself, base64url-encoded, plus a "." delimiter,
// so the returned string is a single self-contained artifact — no separate key needed to decode it later.
// IMPORTANT: once the key travels inside the code, the AES-GCM/PBKDF2 layer is no longer a confidentiality
// boundary (anyone holding the combined string can decrypt it) — it's now just a stable, tamper-evident
// packaging format. Pass combineKeyWithCode: false for the old behavior (ciphertext-only code, key kept
// separate), which is still the only mode where the code alone doesn't reveal the quiz.
async function exportToQuizCode(quizObject, secretKey, combineKeyWithCode = true) {
  if (!secretKey) throw new Error('Enter a secret key before generating a Quiz Code.');
  validateQuiz(quizObject);

  const json = JSON.stringify(quizObject);
  const compressed = await gzipCompress(json);

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(secretKey, salt);

  const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed);
  const ciphertext = new Uint8Array(ciphertextBuf);

  const combined = new Uint8Array(salt.length + iv.length + ciphertext.length);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(ciphertext, salt.length + iv.length);

  const codePart = bufferToBase64Url(combined);
  if (!combineKeyWithCode) return codePart;

  const keyPart = bufferToBase64Url(new TextEncoder().encode(secretKey));
  return keyPart + QUIZ_CODE_KEY_DELIMITER + codePart;
}

// Splits a combined Quiz Code (keyPart + "." + codePart, see exportToQuizCode above) back into its parts.
// A legacy ciphertext-only code (no "." — everything generated before this feature, or any "Separate"-mode
// code) passes through unchanged as { key: null, code: <the whole string> }, so existing shared codes still
// import fine without the person needing to know which mode produced them.
function splitQuizCodeAndKey(combinedCode) {
  const trimmed = (combinedCode || '').trim();
  const delimiterIndex = trimmed.indexOf(QUIZ_CODE_KEY_DELIMITER);
  if (delimiterIndex === -1) return { key: null, code: trimmed };

  const keyPart = trimmed.slice(0, delimiterIndex);
  const codePart = trimmed.slice(delimiterIndex + 1);
  try {
    const key = new TextDecoder().decode(base64UrlToBuffer(keyPart));
    return { key, code: codePart };
  } catch (e) {
    // keyPart wasn't valid base64url — the "." was incidental, not this format's delimiter; treat the
    // whole string as a legacy/plain code rather than throwing.
    return { key: null, code: trimmed };
  }
}

// ---------- Quiz Code modal wiring ----------
// generates a random secret key for Quiz Code encryption
function generateSecretKey() {
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return bufferToBase64Url(bytes);
  } catch (e) {
    return '';
  }
}

// Shows the secret-key row only in "separate" mode — in combined (default) mode the key travels inside the
// code itself, so a standalone key field/Copy button would be redundant. Never removes the DOM node: other
// code paths (Regenerate, the initial seed below) still read/write secretKeyInput.value regardless of mode.
function updateSecretKeyRowVisibility() {
  if (!secretKeyRow) return;
  const separateMode = !!(combineKeyToggle && combineKeyToggle.checked);
  secretKeyRow.classList.toggle('hidden', !separateMode);
}

// opens the Quiz Code modal, resetting its fields (combined mode by default) and seeding a secret key if empty
function openModal() {
  modalError.classList.add('hidden');
  codeResultBox.classList.add('hidden');
  quizCodeOutput.value = '';
  if (!secretKeyInput.value) secretKeyInput.value = generateSecretKey();
  if (combineKeyToggle) combineKeyToggle.checked = false; // unchecked = combined, the default mode
  updateSecretKeyRowVisibility();
  quizCodeModal.classList.remove('hidden');
}
function closeModal() { quizCodeModal.classList.add('hidden'); }

quizCodeBtn.addEventListener('click', openModal);
closeModalBtn.addEventListener('click', closeModal);
quizCodeModal.addEventListener('click', (e) => { if (e.target === quizCodeModal) closeModal(); });
if (combineKeyToggle) combineKeyToggle.addEventListener('change', updateSecretKeyRowVisibility);

copySecretBtn.addEventListener('click', async () => {
  if (!secretKeyInput.value) return;
  try {
    await navigator.clipboard.writeText(secretKeyInput.value);
    copySecretBtn.textContent = 'Copied!';
    setTimeout(() => { copySecretBtn.textContent = 'Copy'; }, 1500);
  } catch (e) {
    secretKeyInput.select();
    document.execCommand('copy');
    copySecretBtn.textContent = 'Copied!';
    setTimeout(() => { copySecretBtn.textContent = 'Copy'; }, 1500);
  }
});
regenSecretBtn.addEventListener('click', () => { secretKeyInput.value = generateSecretKey(); });

generateCodeBtn.addEventListener('click', async () => {
  modalError.classList.add('hidden');
  let quizObject;
  try {
    quizObject = buildQuizObject();
    validateQuiz(quizObject);
  } catch (err) {
    modalError.textContent = err.message;
    modalError.classList.remove('hidden');
    return;
  }

  const separateMode = !!(combineKeyToggle && combineKeyToggle.checked);

  generateCodeBtn.disabled = true;
  generateCodeBtn.textContent = 'Generating...';
  try {
    const code = await exportToQuizCode(quizObject, secretKeyInput.value, !separateMode);
    quizCodeOutput.value = code;
    codeResultBox.classList.remove('hidden');
    updateSecretKeyRowVisibility();
  } catch (err) {
    modalError.textContent = err.message;
    modalError.classList.remove('hidden');
  } finally {
    generateCodeBtn.disabled = false;
    generateCodeBtn.textContent = 'Generate →';
  }
});

copyCodeBtn.addEventListener('click', async () => {
  if (!quizCodeOutput.value) return;
  try {
    await navigator.clipboard.writeText(quizCodeOutput.value);
    copyCodeBtn.textContent = 'Copied!';
    setTimeout(() => { copyCodeBtn.textContent = 'Copy'; }, 1500);
  } catch (e) {
    quizCodeOutput.select();
    document.execCommand('copy');
    copyCodeBtn.textContent = 'Copied!';
    setTimeout(() => { copyCodeBtn.textContent = 'Copy'; }, 1500);
  }
});

// Downloads the exact string currently shown in the code box (combined key+code, or code-only in separate
// mode) as a .txt file — same Blob + <a download> pattern as exportJson() above.
if (downloadCodeBtn) {
  downloadCodeBtn.addEventListener('click', () => {
    if (!quizCodeOutput.value) return;
    const blob = new Blob([quizCodeOutput.value], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const slug = quizTitleInput.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'quiz';
    a.download = slug + '-code.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

export {
  buildQuizObject,
  validateQuiz,
  exportJson,
  bufferToBase64Url,
  base64UrlToBuffer,
  gzipCompress,
  deriveKey,
  exportToQuizCode,
  splitQuizCodeAndKey,
  generateSecretKey,
  getOrAssignLessonId,
  openModal,
  closeModal,
};
