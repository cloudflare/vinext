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
 * `createAppPayloadSlotId` in `app-elements-wire.ts`), each optionally preceded
 * by the 16-hex-digit hash of the slot's shell identity and `#` (see
 * `createMountedSlotToken`); anything else is rejected. A slot id always starts
 * with `slot:`, so the hash can't be read out of a legacy token's tree path.
 *
 * Bounds applied:
 *   - Total raw header value capped at MAX_RAW_HEADER_LENGTH bytes (returns null
 *     if exceeded so the request is treated as if the header were absent).
 *   - Each token's slot id capped at MAX_TOKEN_LENGTH bytes.
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
 *   - app-page-element-builder / app-page-route-wiring (which mounted slots a
 *     render leaves out)
 */

import { compareStrings } from "../utils/compare.js";
import { fnv1a64 } from "../utils/hash.js";
import { isAppElementsWireSlotId } from "./app-elements-wire-key.js";

/** Hard cap on a single token's slot id byte length. */
const MAX_TOKEN_LENGTH = 256;
/** Hard cap on the number of slot tokens kept after normalization. */
const MAX_SLOT_TOKENS = 16;

const SHELL_IDENTITY_PREFIX = /^([0-9a-f]{16})#/;
/** The length of a token's shell identity hash and its `#`. */
const SHELL_IDENTITY_PREFIX_LENGTH = 17;

/**
 * Hard cap on the raw header value byte length: the most tokens kept, each at
 * its longest with a separator. Real values are <1 KB.
 */
const MAX_RAW_HEADER_LENGTH =
  MAX_SLOT_TOKENS * (MAX_TOKEN_LENGTH + SHELL_IDENTITY_PREFIX_LENGTH + 1);

/**
 * A mounted slot's token: its id and, when known, the hash of its shell's
 * segment identity, which binds the slot to its owner layout's route prefix
 * and that prefix's params. A render keeps the client's content only for a
 * slot whose shell keeps that identity, as Next.js renders a slot's default
 * afresh below a segment whose params changed.
 */
export function createMountedSlotToken(slotId: string, shellIdentity: string | undefined): string {
  return shellIdentity === undefined ? slotId : `${fnv1a64(shellIdentity)}#${slotId}`;
}

function splitMountedSlotToken(token: string): {
  shellIdentityHash: string | null;
  slotId: string;
} {
  const match = SHELL_IDENTITY_PREFIX.exec(token);
  return match
    ? { shellIdentityHash: match[1]!, slotId: token.slice(SHELL_IDENTITY_PREFIX_LENGTH) }
    : { shellIdentityHash: null, slotId: token };
}

/**
 * Validate a single mounted-slot token. Shape validation is delegated to the
 * AppElements wire codec so the wire format definition lives in exactly one
 * place. This module only enforces the additional security cap on token byte
 * length to bound cache-key cardinality.
 */
function isValidSlotToken(token: string): boolean {
  const { slotId } = splitMountedSlotToken(token);
  if (slotId.length === 0 || slotId.length > MAX_TOKEN_LENGTH) return false;
  return isAppElementsWireSlotId(slotId);
}

export function normalizeMountedSlotsHeader(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.length > MAX_RAW_HEADER_LENGTH) return null;
  const validTokens = raw.split(/\s+/).filter((token) => token && isValidSlotToken(token));
  if (validTokens.length === 0) return null;
  // Sorted by slot id, as before tokens carried a hash.
  const normalized = Array.from(new Set(validTokens))
    .map((token) => ({ slotId: splitMountedSlotToken(token).slotId, token }))
    .sort((a, b) => compareStrings(a.slotId, b.slotId) || compareStrings(a.token, b.token))
    .slice(0, MAX_SLOT_TOKENS)
    .map(({ token }) => token)
    .join(" ");
  return normalized || null;
}

/**
 * The slots a normalized header names. Whether a render keeps one of them is
 * `keepsMountedSlot`'s decision.
 */
export type MountedSlots = ReadonlyMap<string, string | null>;

export function parseMountedSlotsHeader(normalized: string | null): MountedSlots | null {
  if (!normalized) return null;
  const slots = new Map<string, string | null>();
  for (const token of normalized.split(" ")) {
    const { shellIdentityHash, slotId } = splitMountedSlotToken(token);
    slots.set(slotId, shellIdentityHash);
  }
  return slots;
}

/**
 * Whether the client holds the slot's content for a render whose slot shell
 * has `shellIdentity`. A token without a hash, or a render without the
 * identity, can't tell, so the client's content stays.
 */
export function keepsMountedSlot(
  slots: MountedSlots | null | undefined,
  slotId: string,
  shellIdentity: string | undefined,
): boolean {
  if (!slots?.has(slotId)) return false;
  const shellIdentityHash = slots.get(slotId) ?? null;
  return (
    shellIdentityHash === null ||
    shellIdentity === undefined ||
    shellIdentityHash === fnv1a64(shellIdentity)
  );
}
