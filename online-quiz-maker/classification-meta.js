// classification-meta.js
// Shared-context module, not explicitly named in MODULARIZATION_SCHEMA.txt's
// SHARED CONTEXT list but required by it implicitly: TIER_META,
// VERIFY_META, and DATA_STATUS_META (source lines 877-924) are read from
// more than one module (question-model.js, editor-render.js,
// highlighting.js, snippet-question-generation.js — see the matching NOTE
// in question-model.js), so per the schema's own "do not duplicate —
// these live in ONE place" rule for shared constants, they're lifted
// verbatim into this dedicated module instead of being copy-pasted into
// each. Values are UNCHANGED from source — only import/export wrapper
// lines were added.

// ---------------------------------------------------------------------
// Verbatim from source, lines 877-881
// ---------------------------------------------------------------------
const TIER_META = {
  1: { label: 'Tier 1 · Essential', color: '#facc15', highlightClass: 'source-highlight-tier1' },
  2: { label: 'Tier 2 · Detail', color: '#facc15', highlightClass: 'source-highlight-tier2' },
  3: { label: 'Tier 3 · Minor', color: '#94a3b8', highlightClass: 'source-highlight-tier3' },
};

// ---------------------------------------------------------------------
// Verbatim from source, lines 892-897
// ---------------------------------------------------------------------
const VERIFY_META = {
  1: { label: 'Verified', color: '#1d4ed8' },
  2: { label: 'Semi-verified', color: '#3730a3' },
  3: { label: 'Unverified', color: '#6d28d9' },
  4: { label: 'Unclassified', color: '#9f1239' },
};

// ---------------------------------------------------------------------
// Verbatim from source, lines 920-924
// ---------------------------------------------------------------------
const DATA_STATUS_META = {
  unclassified: { label: 'Unclassified', color: '#9f1239' },
  unverified: { label: 'Unverified', color: '#6d28d9' },
  verified: { label: 'Verified', color: '#1d4ed8' },
};

export { TIER_META, VERIFY_META, DATA_STATUS_META };
