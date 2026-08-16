import { fnv1a64 } from "../utils/hash.js";

export type AppRscStateFingerprintInput = {
  pathAndSearch: string;
  routeId: string;
};

/**
 * Compact identity for the visible App Router state that produced an RSC
 * request. This is deliberately separate from Next-Router-State-Tree: vinext
 * does not emit Next.js' Flight router-tree wire format, so reusing that header
 * would give it incorrect routing semantics.
 */
export function createAppRscStateFingerprint(input: AppRscStateFingerprintInput): string {
  return fnv1a64(JSON.stringify([input.pathAndSearch, input.routeId]));
}
