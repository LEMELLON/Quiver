// classification-meta.js

// Tier badge labels/colors for source-highlight classification.
const TIER_META = {
  1: { label: 'Tier 1 · Essential', color: '#facc15', highlightClass: 'source-highlight-tier1' },
  2: { label: 'Tier 2 · Detail', color: '#facc15', highlightClass: 'source-highlight-tier2' },
  3: { label: 'Tier 3 · Minor', color: '#94a3b8', highlightClass: 'source-highlight-tier3' },
};

// Verification-level badge labels/colors.
const VERIFY_META = {
  1: { label: 'Verified', color: '#1d4ed8' },
  2: { label: 'Semi-verified', color: '#3730a3' },
  3: { label: 'Unverified', color: '#6d28d9' },
  4: { label: 'Unclassified', color: '#9f1239' },
};

// Data-status badge labels/colors.
const DATA_STATUS_META = {
  unclassified: { label: 'Unclassified', color: '#9f1239' },
  unverified: { label: 'Unverified', color: '#6d28d9' },
  verified: { label: 'Verified', color: '#1d4ed8' },
};

export { TIER_META, VERIFY_META, DATA_STATUS_META };
