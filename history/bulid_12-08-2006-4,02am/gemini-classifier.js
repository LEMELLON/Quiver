/**
 * Gemini Key Classifier & Security Abstraction Module
 * Flow: Config -> Classifier -> Website Integration
 */
(function (global) {
  'use strict';

  // Private internal state for key security
  let _rawApiKey = '';
  let _classifiedModels = [];
  let _isInitialized = false;

  const STORAGE_KEY = 'quizMaker.apiKey';

  const GeminiClassifier = {
    /**
     * Set and securely store the API key in memory and localStorage
     */
    setKey(key) {
      _rawApiKey = (key || '').trim();
      try {
        if (_rawApiKey) {
          localStorage.setItem(STORAGE_KEY, _rawApiKey);
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch (e) {
        console.warn('LocalStorage unavailable for API key storage.');
      }
    },

    /**
     * Retrieve stored API key securely
     */
    getKey() {
      if (!_rawApiKey) {
        try {
          _rawApiKey = localStorage.getItem(STORAGE_KEY) || '';
        } catch (e) {
          _rawApiKey = '';
        }
      }
      return _rawApiKey;
    },

    /**
     * Returns a masked version of the key for UI safety (e.g. "AIzaSy...X9a")
     */
    getMaskedKey() {
      const key = this.getKey();
      if (!key) return '';
      if (key.length <= 10) return '••••••••';
      return `${key.substring(0, 6)}...${key.substring(key.length - 4)}`;
    },

    /**
     * Queries Google Gemini API to discover supported generation models for the key
     */
    async classifyKeyModels(customKey = null) {
      const activeKey = customKey || this.getKey();
      if (!activeKey) {
        _classifiedModels = [];
        return { success: false, reason: 'NO_KEY', models: [] };
      }

      // Check if OpenAI key pattern
      if (activeKey.startsWith('sk-')) {
        _classifiedModels = [
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai' },
          { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' }
        ];
        return { success: true, provider: 'openai', models: _classifiedModels };
      }

      // Query Gemini API Model Service
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(activeKey)}`;
        const res = await fetch(endpoint);

        if (!res.ok) {
          throw new Error(`API Returned status ${res.status}`);
        }

        const data = await res.json();
        const availableList = data.models || [];

        // Filter models that support text generation (generateContent)
        const validGeminiModels = availableList
          .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
          .map(m => {
            const cleanId = m.name.replace('models/', '');
            return {
              id: cleanId,
              name: m.displayName || cleanId,
              provider: 'gemini',
              version: m.version || ''
            };
          });

        if (validGeminiModels.length === 0) {
          throw new Error('No compatible generateContent models found for this key.');
        }

        _classifiedModels = validGeminiModels;
        _isInitialized = true;
        return { success: true, provider: 'gemini', models: validGeminiModels };

      } catch (err) {
        console.warn('Gemini Classifier error, using resilient fallback list:', err.message);
        // Resilient fallback using modern active Gemini model IDs
        _classifiedModels = [
          { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (Fallback)', provider: 'gemini' },
          { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (Fallback)', provider: 'gemini' },
          { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (Fallback)', provider: 'gemini' }
        ];
        return { success: false, reason: err.message, models: _classifiedModels };
      }
    },

    /**
     * Abstracted execution method for Gemini requests
     */
    async generateContent(model, systemPrompt, userPrompt) {
      const apiKey = this.getKey();
      if (!apiKey) throw new Error('API Key is missing.');

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.4,
          },
        }),
      });

      if (!response.ok) {
        let detail = '';
        try { detail = (await response.json())?.error?.message || ''; } catch (e) {}
        throw new Error(`Gemini API error (${response.status})${detail ? ': ' + detail : ''}`);
      }

      const data = await response.json();
      return (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    }
  };

  global.GeminiClassifier = GeminiClassifier;
})(window);
