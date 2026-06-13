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

export async function preloadInitialClientReferencesFromRscStream(
  stream: ReadableStream<Uint8Array>,
  options: {
    clientRequire?: ClientReferenceRequire;
    onPreloadError?: ClientReferencePreloadErrorHandler;
  } = {},
): Promise<ReadableStream<Uint8Array>> {
  const clientRequire = options.clientRequire ?? globalThis.__vite_rsc_client_require__;
  if (!clientRequire) return stream;

  const [preloadStream, renderStream] = stream.tee();
  const reader = preloadStream.getReader();
  const decoder = new TextDecoder();
  const referenceIds = new Set<string>();
  let pendingText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = pendingText + decoder.decode(value, { stream: true });
      const lines = text.split("\n");
      pendingText = lines.pop() ?? "";
      readClientReferenceIdsFromRscText(lines.join("\n"), referenceIds);
    }

    pendingText += decoder.decode();
    if (pendingText) {
      readClientReferenceIdsFromRscText(pendingText, referenceIds);
    }

    await preloadClientReferenceIds(referenceIds, clientRequire, options.onPreloadError);
  } finally {
    reader.releaseLock();
  }

  return renderStream;
}
