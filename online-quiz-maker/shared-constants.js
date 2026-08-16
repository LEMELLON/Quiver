// shared-constants.js
// Shared-context module, not explicitly named in MODULARIZATION_SCHEMA.txt's
// SHARED CONTEXT list but required by it implicitly: MIN_CHOICES (source
// line 1273) is read from both editor-render.js (source line 1275, 1619)
// and variant-generation.js's isValidChoiceCount (source line 3099) — see
// the matching NOTE in editor-render.js. Per the schema's "do not
// duplicate" rule for shared constants, it's lifted verbatim into this
// dedicated module instead of being copy-pasted into each. Value is
// UNCHANGED from source — only the import/export wrapper lines were
// added.

// ---------------------------------------------------------------------
// Verbatim from source, line 1273
// ---------------------------------------------------------------------
const MIN_CHOICES = 2;

export { MIN_CHOICES };
