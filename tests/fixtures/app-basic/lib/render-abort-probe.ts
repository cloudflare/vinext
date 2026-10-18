// Lets tests/node-request-cancellation.test.ts hold a page render open until
// the client has disconnected, then finish the shell while a Suspense boundary
// below it is still pending. The server must discard the rendered body without
// reporting the abort as a render error.

type Deferred = { promise: Promise<void>; resolve: () => void };

type RenderAbortProbe = {
  /** Whether the page component started rendering. */
  started: boolean;
  /** Resolved by `?mode=release`, letting the page shell finish. */
  released: Deferred;
  /** Resolved by `?mode=finish`, letting the Suspense boundary finish. */
  finished: Deferred;
};

const PROBES_KEY = Symbol.for("vinext.test.renderAbortProbes");

function probes(): Map<string, RenderAbortProbe> {
  const existing: unknown = Reflect.get(globalThis, PROBES_KEY);
  if (existing instanceof Map) return existing;
  const created = new Map<string, RenderAbortProbe>();
  Reflect.set(globalThis, PROBES_KEY, created);
  return created;
}

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function probe(id: string): RenderAbortProbe {
  const existing = probes().get(id);
  if (existing) return existing;
  const created: RenderAbortProbe = { started: false, released: deferred(), finished: deferred() };
  probes().set(id, created);
  return created;
}

/** Marks the page render as started and waits for `?mode=release`. */
export function startRenderAbortProbe(id: string): Promise<void> {
  const current = probe(id);
  current.started = true;
  return current.released.promise;
}

/** Waits for `?mode=finish`, keeping the Suspense boundary pending until then. */
export function waitForRenderAbortBoundary(id: string): Promise<void> {
  return probe(id).finished.promise;
}

/**
 * `?mode=status&id=<id>` reports whether the page render for `<id>` started.
 * `?mode=release&id=<id>` lets the page shell finish.
 * `?mode=finish&id=<id>` lets the Suspense boundary finish and forgets the probe.
 */
export async function handleRenderAbortProbe(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  const mode = url.searchParams.get("mode");
  const headers = { "cache-control": "no-store" };
  if (mode === "status") {
    const current = probes().get(id);
    return Response.json(current ? { started: current.started } : null, { headers });
  }
  if (mode === "release") {
    probe(id).released.resolve();
    return Response.json({ ok: true }, { headers });
  }
  if (mode === "finish") {
    probe(id).finished.resolve();
    probes().delete(id);
    return Response.json({ ok: true }, { headers });
  }
  return Response.json({ error: "unknown mode" }, { status: 400, headers });
}
