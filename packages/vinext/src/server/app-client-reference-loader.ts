type ReactFlightThenable<T> = Promise<T> & {
  __vinextReactFlightTracked?: true;
  reason?: unknown;
  status?: "fulfilled" | "pending" | "rejected";
  value?: T;
};

type ClientReferenceRequire = (id: string) => Promise<unknown>;
type ClientReferencePreloadErrorHandler = (id: string, error: unknown) => void;

const CLIENT_REFERENCE_REQUIRE_WRAPPED = Symbol.for("vinext.clientReferenceRequireWrapped");

type WrappedClientReferenceRequire = ClientReferenceRequire & {
  [CLIENT_REFERENCE_REQUIRE_WRAPPED]?: true;
};

export function annotateReactFlightThenable<T>(promise: Promise<T>): ReactFlightThenable<T> {
  const thenable = promise as ReactFlightThenable<T>;
  if (thenable.__vinextReactFlightTracked === true || thenable.status !== undefined) {
    return thenable;
  }

  thenable.__vinextReactFlightTracked = true;
  thenable.status = "pending";
  thenable.reason = thenable;
  thenable.then(
    (value) => {
      thenable.status = "fulfilled";
      thenable.value = value;
      thenable.reason = undefined;
    },
    (reason) => {
      thenable.status = "rejected";
      thenable.reason = reason;
    },
  );

  return thenable;
}

export function installReactFlightClientReferenceRequire(): void {
  const existing = globalThis.__vite_rsc_client_require__;
  if (!existing) return;

  const maybeWrapped = existing as WrappedClientReferenceRequire;
  if (maybeWrapped[CLIENT_REFERENCE_REQUIRE_WRAPPED] === true) return;

  const wrapped: WrappedClientReferenceRequire = (id) => annotateReactFlightThenable(existing(id));
  wrapped[CLIENT_REFERENCE_REQUIRE_WRAPPED] = true;
  globalThis.__vite_rsc_client_require__ = wrapped;
}

function readClientReferenceIdsFromRscText(text: string, ids: Set<string>): void {
  for (const line of text.split("\n")) {
    const payloadStart = line.indexOf(":I[");
    if (payloadStart === -1) continue;

    try {
      const row = JSON.parse(line.slice(payloadStart + 2)) as unknown;
      const referenceId = Array.isArray(row) ? row[0] : undefined;
      if (typeof referenceId === "string") {
        ids.add(referenceId);
      }
    } catch {
      // Ignore non-client-reference rows and partial text. React remains the
      // authoritative RSC parser for the stream passed through the second tee.
    }
  }
}

async function preloadClientReferenceIds(
  ids: Iterable<string>,
  clientRequire: ClientReferenceRequire,
  onPreloadError?: ClientReferencePreloadErrorHandler,
): Promise<void> {
  await Promise.all(
    Array.from(ids, (id) =>
      annotateReactFlightThenable(clientRequire(id)).catch((error: unknown) => {
        onPreloadError?.(id, error);
      }),
    ),
  );
}

export function preloadInitialClientReferencesFromRscStream(
  stream: ReadableStream<Uint8Array>,
  options: {
    clientRequire?: ClientReferenceRequire;
    onPreloadError?: ClientReferencePreloadErrorHandler;
  } = {},
): { stream: ReadableStream<Uint8Array>; preloaded: Promise<void> } {
  const clientRequire = options.clientRequire ?? globalThis.__vite_rsc_client_require__;
  if (!clientRequire) return { stream, preloaded: Promise.resolve() };

  const [preloadStream, renderStream] = stream.tee();
  // Warm up the initial client-reference imports on the preload branch while
  // React consumes the render branch concurrently. This MUST stay off the
  // hydration critical path: awaiting full-stream consumption would keep
  // already-rendered, above-the-fold client components non-interactive until
  // the tail of a streamed RSC payload (e.g. a slow Suspense boundary) settles.
  // installReactFlightClientReferenceRequire() already annotates every import
  // thenable so React tracks in-flight modules on its own, so this is a pure
  // warm-up, not a correctness gate. The returned `preloaded` promise is only
  // for diagnostics/tests to observe warm-up completion — callers must not gate
  // hydration on it.
  const preloaded = drainAndPreloadClientReferences(
    preloadStream,
    clientRequire,
    options.onPreloadError,
  );
  return { stream: renderStream, preloaded };
}

// Reads the tee'd preload branch to completion, kicking off the import for each
// client reference id as soon as its row is parsed (rather than batching after
// the stream closes) so the warm-up overlaps the remainder of the stream.
async function drainAndPreloadClientReferences(
  preloadStream: ReadableStream<Uint8Array>,
  clientRequire: ClientReferenceRequire,
  onPreloadError?: ClientReferencePreloadErrorHandler,
): Promise<void> {
  const reader = preloadStream.getReader();
  const decoder = new TextDecoder();
  const started = new Set<string>();
  const imports: Promise<void>[] = [];
  let pendingText = "";

  const preloadFreshIds = (chunkText: string): void => {
    const ids = new Set<string>();
    readClientReferenceIdsFromRscText(chunkText, ids);
    const fresh: string[] = [];
    for (const id of ids) {
      if (started.has(id)) continue;
      started.add(id);
      fresh.push(id);
    }
    if (fresh.length > 0) {
      imports.push(preloadClientReferenceIds(fresh, clientRequire, onPreloadError));
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = pendingText + decoder.decode(value, { stream: true });
      const lines = text.split("\n");
      pendingText = lines.pop() ?? "";
      preloadFreshIds(lines.join("\n"));
    }

    pendingText += decoder.decode();
    if (pendingText) {
      preloadFreshIds(pendingText);
    }

    await Promise.all(imports);
  } finally {
    reader.releaseLock();
  }
}
