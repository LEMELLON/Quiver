# Running the Quiz Maker offline / on a phone

1. Serve this folder over **http(s):// or localhost** (not `file://` — service workers, WebGPU workers and ES modules do not run there):
   `python3 -m http.server 8000`, then open `http://localhost:8000/online-quiz-maker.html`. For a phone, serve it over HTTPS (or use your browser's port-forwarding to localhost).
2. Open the page once **online**. Under *Import Document → Offline & storage*, tap **Make app available offline** (saves the OCR files and the in-browser AI runtime).
3. If you use in-browser Qwen: choose *Qwen in this browser*, then **Download model for offline use** (a few hundred MB or more — use Wi-Fi). **Protect storage** asks the browser not to clear it.
4. On a phone, use the browser's **Install** / **Add to Home Screen** option.
5. **Delete cached model** frees the model's storage again.
