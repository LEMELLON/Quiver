// status-helpers.js

import { parseStatus, selectionGenStatus } from './dom-refs.js';

// Sets or clears the parse-status message line, styled by tone.
function setParseStatus(msg, tone) {
  if (!msg) { parseStatus.classList.add('hidden'); parseStatus.textContent = ''; return; }
  parseStatus.textContent = msg;
  parseStatus.className = 'mt-3 text-xs font-mono ' + (tone === 'error' ? 'text-danger' : tone === 'success' ? 'text-amber' : 'text-mute');
}

// Sets or clears the selection-generation status line, styled by tone.
function setSelectionGenStatus(msg, tone) {
  if (!msg) { selectionGenStatus.classList.add('hidden'); selectionGenStatus.textContent = ''; return; }
  selectionGenStatus.textContent = msg;
  selectionGenStatus.className = 'shrink-0 border-t border-edge px-4 py-2 text-xs font-mono ' +
    (tone === 'error' ? 'text-danger' : tone === 'success' ? 'text-amber' : 'text-mute');
}

export { setParseStatus, setSelectionGenStatus };
