// Lets tests/e2e/app-router/isr.spec.ts hold a draft render's unstable_cache()
// call until its response has been sent, and see when that call has finished.

type DraftLateCacheProbe = {
  /** Resolved by `?mode=release`, letting the held draft render continue. */
  release: () => void;
  released: Promise<void>;
  /** Whether the late unstable_cache() call has returned. */
  done: boolean;
};

const PROBES_KEY = Symbol.for("vinext.test.draftLateCacheProbes");

function probes(): Map<string, DraftLateCacheProbe> {
  const existing: unknown = Reflect.get(globalThis, PROBES_KEY);
  if (existing instanceof Map) return existing;
  const created = new Map<string, DraftLateCacheProbe>();
  Reflect.set(globalThis, PROBES_KEY, created);
  return created;
}

function probe(id: string): DraftLateCacheProbe {
  const existing = probes().get(id);
  if (existing) return existing;
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const created: DraftLateCacheProbe = { release, released, done: false };
  probes().set(id, created);
  return created;
}

/** Waits for `?mode=release`. */
export function waitForDraftLateCacheRelease(id: string): Promise<void> {
  return probe(id).released;
}

export function markDraftLateCacheDone(id: string): void {
  probe(id).done = true;
}

/**
 * `?mode=release&id=<id>` lets the held draft render continue.
 * `?mode=status&id=<id>` reports whether its unstable_cache() call returned.
 */
export async function handleDraftLateCacheProbe(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  const mode = url.searchParams.get("mode");
  const headers = { "cache-control": "no-store" };
  if (mode === "release") {
    probe(id).release();
    return Response.json({ ok: true }, { headers });
  }
  if (mode === "status") {
    return Response.json({ done: probes().get(id)?.done === true }, { headers });
  }
  return Response.json({ error: "unknown mode" }, { status: 400, headers });
}
