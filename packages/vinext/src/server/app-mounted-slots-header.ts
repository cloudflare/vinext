/**
 * Normalize the `x-vinext-mounted-slots` header for request handling and cache keying.
 *
 * The browser sends mounted slot ids as a space-separated list in the order slots were
 * rendered, which changes across navigations. This normalizes to a canonical form
 * (sorted, deduplicated) so equivalent slot sets map to the same RSC cache entry.
 *
 * Security: the value flows into the ISR RSC cache key (`appIsrRscKey`). Without
 * bounds, an attacker who controls this header can fabricate unbounded distinct
 * values to fan out KV writes (per-write billing) or fragment the cache. See
 * `SECURITY-AUDIT-2026-05.md` finding F-PROD-1. The legitimate wire format is a
 * whitespace-separated list of `slot:<name>:<treePath>` tokens (see
 * `createAppPayloadSlotId` in `app-elements-wire.ts`); anything else is rejected.
 *
 * Bounds applied:
 *   - Total raw header value capped at MAX_RAW_HEADER_LENGTH bytes (returns null
 *     if exceeded so the request is treated as if the header were absent).
 *   - Each token capped at MAX_TOKEN_LENGTH bytes.
 *   - Token count capped at MAX_SLOT_TOKENS (extras are dropped after sort + dedup).
 *   - Each token must match the legitimate slot-id shape, as defined by the
 *     AppElements wire codec (`AppElementsWire.isSlotId`). Wire-format details
 *     are intentionally kept inside the codec so this module does not duplicate
 *     them. Malformed tokens are dropped silently rather than rejecting the
 *     whole request — this matches the prior forgiving behavior for browsers
 *     that send legitimate but stale formats during rolling deploys.
 *
 * Consumed by:
 *   - app-rsc-request-normalization (request lifecycle, reads incoming header)
 *   - app-elements (outgoing x-vinext-mounted-slots construction)
 *   - isr-cache (RSC cache key generation)
 */

import { AppElementsWire } from "./app-elements-wire.js";

/** Hard cap on the raw header value byte length. Real values are <1 KB. */
const MAX_RAW_HEADER_LENGTH = 4096;
/** Hard cap on a single slot token byte length. */
const MAX_TOKEN_LENGTH = 256;
/** Hard cap on the number of slot tokens kept after normalization. */
const MAX_SLOT_TOKENS = 16;

/**
 * Validate a single mounted-slot token. Shape validation is delegated to the
 * AppElements wire codec so the wire format definition lives in exactly one
 * place. This module only enforces the additional security cap on token byte
 * length to bound cache-key cardinality.
 */
function isValidSlotToken(token: string): boolean {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;
  return AppElementsWire.isSlotId(token);
}

export function normalizeMountedSlotsHeader(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.length > MAX_RAW_HEADER_LENGTH) return null;
  const validTokens = raw.split(/\s+/).filter((token) => token && isValidSlotToken(token));
  if (validTokens.length === 0) return null;
  const normalized = Array.from(new Set(validTokens)).sort().slice(0, MAX_SLOT_TOKENS).join(" ");
  return normalized || null;
}
