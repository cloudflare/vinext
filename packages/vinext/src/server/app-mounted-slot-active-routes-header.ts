import { AppElementsWire, type AppElementsSlotBinding } from "./app-elements-wire.js";

const MAX_RAW_HEADER_LENGTH = 4096;
const MAX_PAIR_LENGTH = 512;

function isRouteId(value: string): boolean {
  return AppElementsWire.parseElementKey(value)?.kind === "route";
}

function decodePairToken(token: string): readonly [string, string] | null {
  if (!token || token.length > MAX_PAIR_LENGTH) return null;
  const separator = token.indexOf("=");
  if (separator <= 0 || separator === token.length - 1) return null;

  try {
    const slotId = decodeURIComponent(token.slice(0, separator));
    const routeId = decodeURIComponent(token.slice(separator + 1));
    if (!AppElementsWire.isSlotId(slotId) || !isRouteId(routeId)) return null;
    return [slotId, routeId];
  } catch {
    return null;
  }
}

function encodePair(slotId: string, routeId: string): string {
  return `${encodeURIComponent(slotId)}=${encodeURIComponent(routeId)}`;
}

function serializePairs(pairs: ReadonlyMap<string, string>): string | null {
  const tokens = Array.from(pairs.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slotId, routeId]) => encodePair(slotId, routeId));
  const retained: string[] = [];
  let length = 0;
  for (const token of tokens) {
    if (token.length > MAX_PAIR_LENGTH) continue;
    const nextLength = length + (retained.length === 0 ? 0 : 1) + token.length;
    if (nextLength > MAX_RAW_HEADER_LENGTH) break;
    retained.push(token);
    length = nextLength;
  }
  return retained.length > 0 ? retained.join(" ") : null;
}

export function normalizeMountedSlotActiveRoutesHeader(
  raw: string | null | undefined,
): string | null {
  if (!raw || raw.length > MAX_RAW_HEADER_LENGTH) return null;

  const pairs = new Map<string, string>();
  for (const token of raw.split(/\s+/)) {
    const pair = decodePairToken(token);
    if (pair !== null) pairs.set(pair[0], pair[1]);
  }
  if (pairs.size === 0) return null;
  return serializePairs(pairs);
}

export function parseMountedSlotActiveRoutesHeader(
  raw: string | null | undefined,
): ReadonlyMap<string, string> | null {
  const normalized = normalizeMountedSlotActiveRoutesHeader(raw);
  if (normalized === null) return null;

  const pairs = new Map<string, string>();
  for (const token of normalized.split(" ")) {
    const pair = decodePairToken(token);
    if (pair !== null) pairs.set(pair[0], pair[1]);
  }
  return pairs.size > 0 ? pairs : null;
}

export function createMountedSlotActiveRoutesHeader(
  slotBindings: readonly AppElementsSlotBinding[],
): string | null {
  const pairs = new Map<string, string>();
  for (const binding of slotBindings) {
    if (binding.state !== "active" || !binding.activeRouteId) continue;
    if (!AppElementsWire.isSlotId(binding.slotId) || !isRouteId(binding.activeRouteId)) continue;
    pairs.set(binding.slotId, binding.activeRouteId);
  }
  return serializePairs(pairs);
}
