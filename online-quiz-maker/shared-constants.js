// shared-constants.js

// Minimum number of answer choices a question must have.
const MIN_CHOICES = 2;

// D10: AI auto-sync of snippets after each edit is OFF. All auto-sync code stays in snippet-question-generation.js and works
// if this is flipped to true; local highlight rechecks on committed edits run regardless (see onSnippetRelevantEdit).
const AUTO_SYNC_ENABLED = false;

// G6: a selection of any length is captured for the scan buttons, but the floating "Create Question" toolbar only appears at this many characters
// (so double-clicking a single word doesn't pop it up). 11 = the old `> 10` rule.
const MIN_CREATE_SELECTION_LEN = 11;

export { MIN_CHOICES, AUTO_SYNC_ENABLED, MIN_CREATE_SELECTION_LEN };
