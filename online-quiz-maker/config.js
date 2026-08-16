// config.js
// Default AI provider settings for Quiz Maker.
//
// SECURITY NOTE: This file is loaded directly in the browser, so anything
// in it — including apiKey — is visible to anyone who opens this page,
// views source, or inspects network/script requests. Only use a real key
// here for a local/personal copy of this tool. Do not commit this file to
// a public repository or ship it to other users; add it to .gitignore.
// For anything multi-user or public-facing, have each person paste their
// own key into the app's API Key field instead (it stays in their browser's
// localStorage and is never bundled into a shared file).

const AI_CONFIG = {
  // Replace with your actual API key (Gemini or OpenAI)
  apiKey: "",

  // Choose your default model:
  // Options: "gemini-1.5-flash", "gemini-1.5-pro", "gpt-4o-mini", "gpt-4o"
  model: "gemini-1.5-flash"
};
