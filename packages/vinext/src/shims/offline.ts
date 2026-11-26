/**
 * next/offline shim
 *
 * `useOffline()` from Next.js's `experimental.useOffline`. It reports `true`
 * while a navigation, Server Action or prefetch is held by a lost connection
 * (see shims/internal/offline.ts), and `false` otherwise. Without the flag no
 * OfflineProvider is mounted and it always reports `false`, as in Next.js.
 */
"use client";

export { useOffline } from "./internal/offline-provider.js";
