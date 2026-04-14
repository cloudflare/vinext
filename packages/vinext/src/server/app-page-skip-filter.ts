/**
 * Skip-filter for RSC wire-format payloads.
 *
 * Architectural role: applied to the egress RSC stream when the client sent
 * `X-Vinext-Router-Skip`. The cache branch writes CANONICAL bytes (full
 * payload) while the response branch rewrites row 0 to delete the skipped
 * layout slot keys and drops orphaned child rows that are now unreferenced.
 *
 * This file is pure: all helpers take data in and return data out. The
 * owning module (`app-page-render.ts`) is responsible for deciding when
 * to apply the filter. The cache-read path (`app-page-cache.ts`) applies
 * the same filter to cached canonical bytes via `wrapRscBytesForResponse`.
 *
 * Wire format reference (React 19.2.x, see `react-server-dom-webpack`):
 *
 *   <hex_id>:<json_or_tagged>\n
 *
 * Row 0 is the root model row. React's DFS post-order emission guarantees
 * that a row's synchronous children are emitted before the row itself,
 * while async children (thenables resolved later) appear after the row
 * that references them. The filter buffers rows until row 0 arrives,
 * computes the live id set from the surviving keys of row 0, emits the
 * buffered rows in stream order (dropping rows not in the live set), then
 * streams subsequent rows through a forward-pass live set.
 */

const REFERENCE_PATTERN = /^\$(?:[LBFQWK@])?([0-9a-fA-F]+)$/;

/**
 * Pure: parses a single RSC reference string like `$L5` or `$ff` and returns
 * the numeric row id it references. Returns null for escape sequences (`$$`)
 * and non-row tagged forms (`$undefined`, `$NaN`, `$Z`, `$T`, etc.).
 */
export function parseRscReferenceString(value: string): number | null {
  const match = REFERENCE_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  return Number.parseInt(match[1], 16);
}

/**
 * Pure: walks any JSON-shaped value and collects every numeric row reference
 * it encounters into `into`. Non-row tagged strings are ignored.
 */
export function collectRscReferenceIds(value: unknown, into: Set<number>): void {
  if (typeof value === "string") {
    const id = parseRscReferenceString(value);
    if (id !== null) {
      into.add(id);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRscReferenceIds(item, into);
    }
    return;
  }
  for (const item of Object.values(value)) {
    collectRscReferenceIds(item, into);
  }
}

/**
 * Pure: given a parsed row 0 record and the set of slot ids to skip, returns
 * a rewritten row 0 (the same object shape minus the skipped keys) and the
 * initial live id set seeded from the surviving keys' references.
 */
export function filterRow0(
  row0: unknown,
  skipIds: ReadonlySet<string>,
): { rewritten: unknown; liveIds: Set<number> } {
  if (row0 === null || typeof row0 !== "object" || Array.isArray(row0)) {
    const liveIds = new Set<number>();
    collectRscReferenceIds(row0, liveIds);
    return { rewritten: row0, liveIds };
  }
  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row0)) {
    if (skipIds.has(key)) {
      continue;
    }
    rewritten[key] = value;
  }
  const liveIds = new Set<number>();
  collectRscReferenceIds(rewritten, liveIds);
  return { rewritten, liveIds };
}

/**
 * A row buffered while we wait for row 0. `kind: "row"` means we parsed a
 * valid `<hex>:` prefix and should consult `liveIds`; `kind: "passthrough"`
 * means the line did not parse as a row and must be emitted verbatim once
 * we know what to do with the buffer (mirroring streaming-phase behavior
 * for unrecognized lines).
 */
type PendingRow = { kind: "row"; id: number; raw: string } | { kind: "passthrough"; raw: string };

type FilterState =
  | { phase: "initial"; carry: string; pending: PendingRow[] }
  | { phase: "streaming"; carry: string; liveIds: Set<number> }
  | { phase: "passthrough"; carry: string };

const ROW_PREFIX_PATTERN = /^([0-9a-fA-F]+):/;
const JSON_START_PATTERN = /[[{]/;

function parseRowIdFromRaw(raw: string): number | null {
  const match = ROW_PREFIX_PATTERN.exec(raw);
  if (match === null) {
    return null;
  }
  return Number.parseInt(match[1], 16);
}

function addRefsFromRaw(raw: string, into: Set<number>): void {
  const colonIndex = raw.indexOf(":");
  if (colonIndex < 0) {
    return;
  }
  const payload = raw.slice(colonIndex + 1);

  // React dev/progressive rows can carry references outside plain JSON
  // object/array payloads, for example `1:D"$3a"`. Track those too so
  // later rows are not dropped as orphans when a kept row introduces a
  // new live id through a deferred chunk.
  for (const match of payload.matchAll(/(?<!\$)\$(?:[LBFQWK@])?([0-9a-fA-F]+)\b/g)) {
    into.add(Number.parseInt(match[1], 16));
  }

  const jsonStart = payload.search(JSON_START_PATTERN);
  if (jsonStart < 0) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.slice(jsonStart));
  } catch {
    return;
  }
  collectRscReferenceIds(parsed, into);
}

function emitRow(
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  raw: string,
): void {
  controller.enqueue(encoder.encode(`${raw}\n`));
}

/**
 * Creates a TransformStream that rewrites row 0 to omit the given `skipIds`
 * and drops any rows that end up orphaned. Empty skipIds yields an identity
 * transform so the hot path pays no parsing cost.
 */
export function createSkipFilterTransform(
  skipIds: ReadonlySet<string>,
): TransformStream<Uint8Array, Uint8Array> {
  if (skipIds.size === 0) {
    return new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
    });
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let state: FilterState = { phase: "initial", carry: "", pending: [] };

  function promoteToStreaming(
    controller: TransformStreamDefaultController<Uint8Array>,
    row0Raw: string,
    pending: readonly PendingRow[],
  ): void {
    const colonIndex = row0Raw.indexOf(":");
    const payload = row0Raw.slice(colonIndex + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // Row 0 should always be a JSON object for App Router payloads. If
      // parsing fails the skip filter cannot produce a correct result, so
      // fall back to emitting the canonical stream unchanged.
      for (const row of pending) {
        emitRow(controller, encoder, row.raw);
      }
      state = { phase: "passthrough", carry: "" };
      return;
    }
    const { rewritten, liveIds } = filterRow0(parsed, skipIds);
    const newRow0Raw = `0:${JSON.stringify(rewritten)}`;

    for (const row of pending) {
      if (row.kind === "passthrough") {
        emitRow(controller, encoder, row.raw);
        continue;
      }
      if (row.id === 0) {
        emitRow(controller, encoder, newRow0Raw);
        continue;
      }
      if (liveIds.has(row.id)) {
        emitRow(controller, encoder, row.raw);
        addRefsFromRaw(row.raw, liveIds);
      }
    }
    state = { phase: "streaming", carry: "", liveIds };
  }

  /**
   * Drains complete rows out of the combined carry+chunk buffer and stores
   * the trailing partial row (if any) on whichever state object is current
   * at the END of the call. The state may be replaced mid-loop when row 0
   * arrives, so this function owns the carry assignment to keep callers
   * free of JS LHS-evaluation hazards.
   */
  function consumeBuffered(
    controller: TransformStreamDefaultController<Uint8Array>,
    buffer: string,
  ): void {
    let cursor = 0;
    while (cursor < buffer.length) {
      const newline = buffer.indexOf("\n", cursor);
      if (newline < 0) {
        state.carry = buffer.slice(cursor);
        return;
      }
      const raw = buffer.slice(cursor, newline);
      cursor = newline + 1;

      if (state.phase === "initial") {
        const id = parseRowIdFromRaw(raw);
        if (id === null) {
          // Mirror streaming-phase behavior for unrecognized lines: pass them
          // through verbatim. Buffered now, emitted in stream order once the
          // pending queue is flushed by promoteToStreaming.
          state.pending.push({ kind: "passthrough", raw });
          continue;
        }
        if (id === 0) {
          const pendingSnapshot: PendingRow[] = [...state.pending, { kind: "row", id: 0, raw }];
          state.pending = [];
          promoteToStreaming(controller, raw, pendingSnapshot);
          // Fall through to the streaming-phase branch on the next iteration
          // so the same buffer keeps draining under the new phase. cursor
          // already points past row 0.
          continue;
        }
        state.pending.push({ kind: "row", id, raw });
        continue;
      }

      if (state.phase === "passthrough") {
        emitRow(controller, encoder, raw);
        continue;
      }

      // streaming phase
      const id = parseRowIdFromRaw(raw);
      if (id === null) {
        // Unrecognized row — pass through verbatim.
        emitRow(controller, encoder, raw);
        continue;
      }
      if (state.liveIds.has(id)) {
        emitRow(controller, encoder, raw);
        addRefsFromRaw(raw, state.liveIds);
      }
    }
    state.carry = "";
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      consumeBuffered(controller, state.carry + text);
    },
    flush(controller) {
      const trailing = decoder.decode();
      const buffer = state.carry + trailing;
      // Force any final partial row through the row-terminating path by
      // synthesizing a newline. consumeBuffered will either complete the
      // pending row 0 transition, or, if row 0 never arrived, leave us in
      // the initial phase with the line buffered in state.pending.
      if (buffer.length > 0) {
        consumeBuffered(controller, `${buffer}\n`);
      }
      if (state.phase === "initial") {
        // Row 0 never arrived. Emit every buffered line verbatim so the
        // client sees the canonical (unfiltered) stream rather than
        // silently losing rows. This branch is defensive — well-formed
        // App Router responses always emit row 0.
        for (const row of state.pending) {
          emitRow(controller, encoder, row.raw);
        }
        state.pending = [];
      }
    },
  });
}

/**
 * Cache-read helper: wraps an ArrayBuffer in either identity (no skip) or a
 * ReadableStream piped through the skip filter. Callers pass the result
 * directly to `new Response(...)` so the underlying bytes are never copied
 * into a string.
 */
export function wrapRscBytesForResponse(
  bytes: ArrayBuffer,
  skipIds: ReadonlySet<string>,
): BodyInit {
  if (skipIds.size === 0) {
    return bytes;
  }
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
  return source.pipeThrough(createSkipFilterTransform(skipIds));
}
