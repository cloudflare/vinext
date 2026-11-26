/**
 * next/offline shim
 *
 * Stub for the experimental `useOffline()` hook added in Next.js
 * (vercel/next.js#92012). Returns `false` (online) unconditionally.
 * Full offline retry behavior (navigation retry, prefetch pause/resume,
 * OfflineProvider) will be implemented once the feature stabilizes upstream.
 */
"use client";

export function useOffline(): boolean {
  return false;
}

// `next/offline` is CommonJS in Next.js, so a default import receives its
// `module.exports`: the entry's public API (packages/next/src/client/components/use-offline.tsx).
export default {
  useOffline,
};
