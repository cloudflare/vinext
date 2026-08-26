import { ensureFetchPatch } from "vinext/shims/fetch-cache";

// Generated server entries import this module before every user module. Next.js
// patches fetch before loading application code; doing the same prevents a
// module-scope `const rawFetch = fetch` alias from escaping cache semantics and
// whole-route dynamic-fetch classification.
ensureFetchPatch();
