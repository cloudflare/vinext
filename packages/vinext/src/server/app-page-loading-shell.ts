import { APP_PREFETCH_LOADING_SHELL_MARKER_KEY } from "./app-elements.js";

const PAGE_SUSPENSE_MARKER = "PageSuspense";
const INVALID_PAGE_SHELL_MARKER = "NotSuspended";
const LAZY_REFERENCE_PATTERN = /^\$L([0-9a-f]+)$/i;
const ASYNC_REFERENCE_PATTERN = /^\$@([0-9a-f]+)$/i;
const RECORD_PATTERN = /^([0-9a-f]+):(.*)$/i;

type FlightRecords = {
  models: Map<string, unknown>;
  terminalIds: Set<string>;
};

function readFlightRecords(bytes: Uint8Array): FlightRecords {
  const models = new Map<string, unknown>();
  const terminalIds = new Set<string>();
  const text = new TextDecoder().decode(bytes);

  for (const line of text.split("\n")) {
    const match = RECORD_PATTERN.exec(line);
    if (!match) continue;
    const id = match[1].toLowerCase();
    const payload = match[2];
    if (payload.startsWith("E") || payload.startsWith("I")) {
      terminalIds.add(id);
      continue;
    }
    try {
      models.set(id, JSON.parse(payload));
    } catch {
      // Debug, binary, and other non-model Flight rows are irrelevant here.
    }
  }

  return { models, terminalIds };
}

function isNonNullFallback(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "$undefined";
}

function isInspectableSelectedRoot(
  value: unknown,
  records: FlightRecords,
  visitedIds = new Set<string>(),
): boolean {
  if (typeof value !== "string") return true;
  const reference = LAZY_REFERENCE_PATTERN.exec(value) ?? ASYNC_REFERENCE_PATTERN.exec(value);
  if (!reference) return true;
  const id = reference[1].toLowerCase();
  if (records.terminalIds.has(id)) return true;
  const model = records.models.get(id);
  if (model === undefined || visitedIds.has(id)) return false;
  visitedIds.add(id);
  return isInspectableSelectedRoot(model, records, visitedIds);
}

function hasPostponedValueWithinSuspense(
  value: unknown,
  records: FlightRecords,
  suspenseTypeIds: ReadonlySet<string>,
  insideSuspense: boolean,
  visitedIds: Set<string>,
  depth = 0,
): boolean {
  if (depth > 100) return false;
  if (typeof value === "string") {
    const reference = LAZY_REFERENCE_PATTERN.exec(value) ?? ASYNC_REFERENCE_PATTERN.exec(value);
    if (!reference) return false;
    const id = reference[1].toLowerCase();
    if (records.terminalIds.has(id)) return false;
    const model = records.models.get(id);
    if (model === undefined) return insideSuspense;
    if (visitedIds.has(id)) return false;
    visitedIds.add(id);
    const found = hasPostponedValueWithinSuspense(
      model,
      records,
      suspenseTypeIds,
      insideSuspense,
      visitedIds,
      depth + 1,
    );
    visitedIds.delete(id);
    return found;
  }
  if (Array.isArray(value)) {
    if (value[0] === "$" && typeof value[1] === "string") {
      const typeReference = /^\$([0-9a-f]+)$/i.exec(value[1]);
      const props = value[3];
      if (typeReference && suspenseTypeIds.has(typeReference[1].toLowerCase())) {
        if (!props || typeof props !== "object" || Array.isArray(props)) return false;
        const fallback = Reflect.get(props, "fallback");
        if (!isNonNullFallback(fallback)) return false;
        return hasPostponedValueWithinSuspense(
          Reflect.get(props, "children"),
          records,
          suspenseTypeIds,
          true,
          visitedIds,
          depth + 1,
        );
      }
      return hasPostponedValueWithinSuspense(
        props,
        records,
        suspenseTypeIds,
        insideSuspense,
        visitedIds,
        depth + 1,
      );
    }
    return value.some((entry) =>
      hasPostponedValueWithinSuspense(
        entry,
        records,
        suspenseTypeIds,
        insideSuspense,
        visitedIds,
        depth + 1,
      ),
    );
  }
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((entry) =>
    hasPostponedValueWithinSuspense(
      entry,
      records,
      suspenseTypeIds,
      insideSuspense,
      visitedIds,
      depth + 1,
    ),
  );
}

export function hasCompletedPageSuspenseShell(bytes: Uint8Array): boolean {
  const records = readFlightRecords(bytes);
  const root = records.models.get("0");
  if (!root || typeof root !== "object" || Array.isArray(root)) return false;
  if (Reflect.get(root, APP_PREFETCH_LOADING_SHELL_MARKER_KEY) !== PAGE_SUSPENSE_MARKER) {
    return false;
  }

  const suspenseTypeIds = new Set<string>();
  for (const [id, value] of records.models) {
    if (value === "$Sreact.suspense") suspenseTypeIds.add(id);
  }
  if (suspenseTypeIds.size === 0) return false;

  const selectedRoots = Object.entries(root).filter(
    ([key]) => key.startsWith("page:") || key.startsWith("slot:children:"),
  );
  if (
    selectedRoots.length === 0 ||
    selectedRoots.some(([, value]) => !isInspectableSelectedRoot(value, records))
  ) {
    return false;
  }

  return selectedRoots.some(([, value]) =>
    hasPostponedValueWithinSuspense(value, records, suspenseTypeIds, false, new Set()),
  );
}

export function invalidateIncompletePageSuspenseShell(bytes: Uint8Array): Uint8Array {
  if (hasCompletedPageSuspenseShell(bytes)) return bytes;

  const marker = new TextEncoder().encode(
    `"${APP_PREFETCH_LOADING_SHELL_MARKER_KEY}":"${PAGE_SUSPENSE_MARKER}"`,
  );
  const replacement = new TextEncoder().encode(
    `"${APP_PREFETCH_LOADING_SHELL_MARKER_KEY}":"${INVALID_PAGE_SHELL_MARKER}"`,
  );
  if (marker.byteLength !== replacement.byteLength) {
    throw new Error("Page shell marker replacement must preserve the Flight payload length");
  }

  const next = bytes.slice();
  outer: for (let index = 0; index <= next.byteLength - marker.byteLength; index++) {
    for (let offset = 0; offset < marker.byteLength; offset++) {
      if (next[index + offset] !== marker[offset]) continue outer;
    }
    next.set(replacement, index);
    return next;
  }
  return bytes;
}
