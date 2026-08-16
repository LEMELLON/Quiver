// quiz-export.js
// Extracted verbatim from online-quiz-maker.html, source lines 4586-4794
// (module [15] per MODULARIZATION_SCHEMA.txt): buildQuizObject,
// validateQuiz, exportJson, bufferToBase64Url, gzipCompress, deriveKey,
// exportToQuizCode, generateSecretKey, openModal, closeModal, plus the
// event-wiring lines for each (moved with handler, per the schema's
// "move with handler" strategy — none of the listener callback bodies
// were altered). Function bodies are UNCHANGED from source — only
// import/export wrapper lines were added.
//
// SOURCE LINE RANGES (in original file order):
//   4589-4611  buildQuizObject
//   4613-4642  validateQuiz
//   4644-4658  exportJson
//   4659       exportJsonBtn listener (moved with handler)
//   4662-4668  bufferToBase64Url
//   4671-4677  gzipCompress
//   4680-4693  deriveKey
//   4695-4715  exportToQuizCode
//   4718-4725  generateSecretKey
//   4727-4733  openModal
//   4734       closeModal
//   4736-4794  quizCodeBtn/closeModalBtn/quizCodeModal/copySecretBtn/
//              regenSecretBtn/generateCodeBtn/copyCodeBtn listeners
//              (all moved with handler — each wires a function defined
//              in this module, and none of them call out to any other
//              module, so nothing further needed importing)

// --- Shared dependencies ---
import { state } from './core-state.js';
import { PBKDF2_ITERATIONS, SALT_LEN, IV_LEN } from './core-state.js';
import {
  quizTitleInput,
  exportJsonBtn,
  quizCodeBtn,
  closeModalBtn,
  secretKeyInput,
  copySecretBtn,
  regenSecretBtn,
  generateCodeBtn,
  codeResultBox,
  quizCodeOutput,
  copyCodeBtn,
  modalError,
  quizCodeModal,
} from './dom-refs.js';

// ---------------------------------------------------------------------
// Verbatim from source, lines 4589-4611
// ---------------------------------------------------------------------
function buildQuizObject() {
  return {
    title: quizTitleInput.value.trim() || 'Untitled Quiz',
    questions: state.questions.map(q => ({
      id: q.id,
      targetTerm: q.targetTerm || '',
      sourcePage: q.sourcePage,
      sourceSnippet: q.sourceSnippet || '',
      answerSnippet: q.answerSnippet || '',
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
    })),
  };
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 4613-4642
// ---------------------------------------------------------------------
function validateQuiz(data) {
  if (!data || typeof data !== 'object') throw new Error('Quiz data is not a valid object.');
  if (!Array.isArray(data.questions) || data.questions.length === 0) throw new Error('Add at least one question first.');
  for (const q of data.questions) {
    // Every collection needs at least one variant to export — the
    // clamp (Multiple Choice) base is no longer required specifically,
    // since it can now be removed like any other variant (see
    // removeVariant) as long as another one takes its place.
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

// ---------------------------------------------------------------------
// Verbatim from source, lines 4644-4658
// ---------------------------------------------------------------------
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
// ---------------------------------------------------------------------
// Verbatim from source, line 4659 (event wiring that belongs to this
// module's own function — moved with handler per the schema's strategy)
// ---------------------------------------------------------------------
exportJsonBtn.addEventListener('click', exportJson);

// ---------- Base64URL helpers ----------
// ---------------------------------------------------------------------
// Verbatim from source, lines 4662-4668
// ---------------------------------------------------------------------
function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------- Native gzip compression ----------
// ---------------------------------------------------------------------
// Verbatim from source, lines 4671-4677
// ---------------------------------------------------------------------
async function gzipCompress(text) {
  if (typeof CompressionStream === 'undefined') throw new Error('This browser does not support CompressionStream.');
  const cs = new CompressionStream('gzip');
  const stream = new Blob([text]).stream().pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// ---------- Key derivation (PBKDF2 -> AES-GCM) ----------
// ---------------------------------------------------------------------
// Verbatim from source, lines 4680-4693
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Verbatim from source, lines 4695-4715
// ---------------------------------------------------------------------
async function exportToQuizCode(quizObject, secretKey) {
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

  return bufferToBase64Url(combined);
}

// ---------- Quiz Code modal wiring ----------
// ---------------------------------------------------------------------
// Verbatim from source, lines 4718-4725
// ---------------------------------------------------------------------
function generateSecretKey() {
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return bufferToBase64Url(bytes);
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------
// Verbatim from source, lines 4727-4733
// ---------------------------------------------------------------------
function openModal() {
  modalError.classList.add('hidden');
  codeResultBox.classList.add('hidden');
  quizCodeOutput.value = '';
  if (!secretKeyInput.value) secretKeyInput.value = generateSecretKey();
  quizCodeModal.classList.remove('hidden');
}
// ---------------------------------------------------------------------
// Verbatim from source, line 4734
// ---------------------------------------------------------------------
function closeModal() { quizCodeModal.classList.add('hidden'); }

// ---------------------------------------------------------------------
// Verbatim from source, lines 4736-4794 (event wiring that belongs to
// this module's own functions — moved with handler per the schema's
// strategy. NOT altered.)
// ---------------------------------------------------------------------
quizCodeBtn.addEventListener('click', openModal);
closeModalBtn.addEventListener('click', closeModal);
quizCodeModal.addEventListener('click', (e) => { if (e.target === quizCodeModal) closeModal(); });

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

  generateCodeBtn.disabled = true;
  generateCodeBtn.textContent = 'Generating...';
  try {
    const code = await exportToQuizCode(quizObject, secretKeyInput.value);
    quizCodeOutput.value = code;
    codeResultBox.classList.remove('hidden');
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

export {
  buildQuizObject,
  validateQuiz,
  exportJson,
  bufferToBase64Url,
  gzipCompress,
  deriveKey,
  exportToQuizCode,
  generateSecretKey,
  openModal,
  closeModal,
};
