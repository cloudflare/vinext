// Server-only configuration for pages/conditional-data-export.tsx. Only that
// page's conditionally assigned getServerSideProps imports it, so neither
// value may appear in any public client chunk.
export const PRIVATE_PAGE_ENABLED = true;
export const PRIVATE_SIGNING_KEY = "VINEXT_CONDITIONAL_GSSP_SIGNING_KEY_5e1c84b2";
