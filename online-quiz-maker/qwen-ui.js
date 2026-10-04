// qwen-ui.js
// Batch 8 — wires the #qwenRow controls (model preset, Load/Cancel/Unload, progress bar, status line, layout checkbox).
// Engine logic lives in qwen-local.js; this file only touches the DOM.
//
// Import order: main.js imports this AFTER ai-credentials-and-models.js. That module's applyProviderUi() runs on provider change and
// may re-show apiKeyRow/modelSelectRow, so this module re-applies its visibility in a setTimeout(0) after the same event.

import {
  providerSelect, apiKeyRow, modelSelectRow, qwenRow, qwenModelSelect, qwenLoadBtn, qwenCancelBtn,
  qwenUnloadBtn, qwenProgressWrap, qwenProgressBar, qwenStatusEl, qwenLayoutToggle,
} from './dom-refs.js';
import { setParseStatus } from './status-helpers.js';
import {
  QWEN_PRESETS, PRESET_ORDER, formatPresetLabel, getSelectedQwenPresetKey, setSelectedQwenPresetKey,
  qwenLayoutFormattingEnabled, setQwenLayoutFormattingEnabled, detectQwenCapabilities, loadQwenModel,
  unloadQwenModel, cancelQwen, getQwenStatus, onQwenStatusChange, isLikelyMobileDevice,
} from './qwen-local.js';

let capabilities = null; // result of detectQwenCapabilities(), filled lazily

function isQwenSelected() { return !!providerSelect && providerSelect.value === 'qwen-browser'; }

function populatePresets() {
  const mobile = isLikelyMobileDevice();
  qwenModelSelect.innerHTML = '';
  for (const key of PRESET_ORDER) {
    const preset = QWEN_PRESETS[key];
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = formatPresetLabel(preset) + (mobile && preset.desktopOnly ? ' — desktop only' : '');
    qwenModelSelect.appendChild(opt);
  }
  qwenModelSelect.value = getSelectedQwenPresetKey();
}

function renderStatus(st = getQwenStatus()) {
  const busy = st.state === 'loading';
  qwenCancelBtn.classList.toggle('hidden', !busy);
  qwenLoadBtn.classList.toggle('hidden', busy);
  qwenProgressWrap.classList.toggle('hidden', !busy);
  qwenProgressBar.style.width = `${Math.round((st.progress || 0) * 100)}%`;
  const noGpu = capabilities && !capabilities.webgpu;
  qwenLoadBtn.disabled = !!noGpu;
  qwenModelSelect.disabled = busy;
  qwenUnloadBtn.disabled = st.state === 'idle' || busy;

  let line;
  if (noGpu) line = capabilities.reason;
  else if (st.state === 'loading') line = `Loading… ${Math.round((st.progress || 0) * 100)}%${st.text ? ` — ${String(st.text).slice(0, 80)}` : ''}`;
  else if (st.state === 'ready' || st.state === 'generating') line = st.state === 'generating' ? 'Model ready — generating…' : 'Model ready (runs fully in this browser).';
  else if (st.state === 'error') line = `Error: ${st.error}`;
  else if (capabilities) line = `WebGPU available${capabilities.shaderF16 ? ' (fast f16 build)' : ' (compatibility f32 build)'}${capabilities.mobile ? ' — mobile device: smallest model recommended' : ''}. Model not loaded yet.`;
  else line = 'Checking WebGPU…';
  qwenStatusEl.textContent = line;
  qwenStatusEl.className = 'text-[0.65rem] font-mono ' + (noGpu || st.state === 'error' ? 'text-danger' : 'text-mute');
}

function applyVisibility() {
  const on = isQwenSelected();
  qwenRow.classList.toggle('hidden', !on);
  if (on) {
    apiKeyRow.classList.add('hidden');
    modelSelectRow.classList.add('hidden');
    if (!capabilities) {
      detectQwenCapabilities().then((c) => { capabilities = c; renderStatus(); }, () => {});
    }
    renderStatus();
  }
}

qwenModelSelect.addEventListener('change', () => setSelectedQwenPresetKey(qwenModelSelect.value));

qwenLoadBtn.addEventListener('click', async () => {
  setSelectedQwenPresetKey(qwenModelSelect.value);
  try {
    await loadQwenModel(qwenModelSelect.value);
  } catch (err) {
    if (!(err && err.isCancelled)) console.warn('Qwen load failed:', err);
  }
  renderStatus();
});

qwenCancelBtn.addEventListener('click', () => {
  cancelQwen();
  setParseStatus('Cancelling…', 'info');
  renderStatus();
});

qwenUnloadBtn.addEventListener('click', async () => {
  await unloadQwenModel();
  setParseStatus('Qwen unloaded; GPU memory freed.', 'info');
  renderStatus();
});

qwenLayoutToggle.checked = qwenLayoutFormattingEnabled();
qwenLayoutToggle.addEventListener('change', () => setQwenLayoutFormattingEnabled(qwenLayoutToggle.checked));

onQwenStatusChange((st) => renderStatus(st));

populatePresets();
if (providerSelect) {
  // Runs after ai-credentials-and-models.js's own 'change' handler (registered earlier) and re-applies the Qwen row afterwards.
  providerSelect.addEventListener('change', () => setTimeout(applyVisibility, 0));
}
// Initial state: the credentials module restores the saved provider during its own init; check after it has run.
setTimeout(applyVisibility, 0);
