// shared-constants.js

// Minimum number of answer choices a question must have.
const MIN_CHOICES = 2;

// D10: AI auto-sync of snippets after each edit is OFF. All auto-sync code stays in snippet-question-generation.js and works
// if this is flipped to true; local highlight rechecks on committed edits run regardless (see onSnippetRelevantEdit).
const AUTO_SYNC_ENABLED = false;

export { MIN_CHOICES, AUTO_SYNC_ENABLED };
