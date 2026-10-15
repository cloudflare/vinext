import { describe, expect, it, vi } from "vite-plus/test";
import { ResponseStoreBinding } from "../packages/workers-response-store/src/binding.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function track(promise: Promise<unknown>): { settled: () => boolean } {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { settled: () => settled };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// The binding's storage I/O, stubbed so each test controls when it settles.
type Internals = {
  deriveCacheKey(request: Request): Promise<{ cacheKey: string; keyHash: string }>;
  getMetadata(): object;
  readR2Metadata(): Promise<{ entry: object | null }>;
  readR2MetadataCached(cacheKey: { cacheKey: string; keyHash: string }): Promise<unknown>;
  reserveWrite(): Promise<{ objectKey: string }>;
  storeResponse(): Promise<object>;
  updateEdgeCacheByTags(tags: string[]): Promise<boolean>;
};

function createBinding(keyHash: string) {
  const lifetimes: Promise<unknown>[] = [];
  const ctx = {
    props: { versionId: "lifetime-test" },
    waitUntil: (promise: Promise<unknown>) => lifetimes.push(promise),
  };
  const binding = new ResponseStoreBinding(ctx as never, {} as never);
  const internals = binding as unknown as Internals;
  internals.deriveCacheKey = async () => ({ cacheKey: `https://store.test/${keyHash}`, keyHash });
  internals.getMetadata = () => ({});
  return { binding, internals, lifetimes };
}

// Pending reads and coalesced puts are shared by every call in the isolate,
// and workerd drops a canceled call's pending I/O. The call that creates an
// entry must stay alive until the entry is cleared, or a settled one is left
// behind for later calls.
describe("Response Store shared work lifetime", () => {
  it("keeps a coalesced put alive until its edge purge and cleanup finish", async () => {
    const { binding, internals, lifetimes } = createBinding("put-lifetime");
    const purge = createDeferred<boolean>();
    const storeResponse = vi.fn(async () => ({
      edgePurgeRequired: true,
      entry: { keyHash: "put-lifetime" },
      published: true,
    }));
    const updateEdgeCacheByTags = vi.fn(() => purge.promise);
    internals.reserveWrite = async () => ({ objectKey: "object" });
    internals.storeResponse = storeResponse;
    internals.updateEdgeCacheByTags = updateEdgeCacheByTags;
    const request = new Request("https://store.test/put-lifetime");

    const put = binding.put(request, new Response("first"), {
      coalesce: true,
      purgeExisting: true,
    });
    await vi.waitFor(() => expect(updateEdgeCacheByTags).toHaveBeenCalledOnce());
    expect(lifetimes).toHaveLength(1);
    const lifetime = track(lifetimes[0]!);
    await flush();
    // The write has published, but the purge and the map cleanup are pending.
    expect(lifetime.settled()).toBe(false);

    purge.resolve(true);
    await expect(put).resolves.toEqual({ backingStoreUpdated: true, edgePurgeAccepted: true });
    await flush();
    expect(lifetime.settled()).toBe(true);

    // The entry was cleared, so a later coalesced put writes again.
    purge.resolve(true);
    await binding.put(request, new Response("second"), { coalesce: true, purgeExisting: true });
    expect(storeResponse).toHaveBeenCalledTimes(2);
  });

  it("keeps a shared metadata read alive until it is cleared", async () => {
    const { internals, lifetimes } = createBinding("read-lifetime");
    const read = createDeferred<{ entry: object | null }>();
    const readR2Metadata = vi.fn(() => read.promise);
    internals.readR2Metadata = readR2Metadata;
    const cacheKey = { cacheKey: "https://store.test/read-lifetime", keyHash: "read-lifetime" };

    const first = internals.readR2MetadataCached(cacheKey);
    expect(lifetimes).toHaveLength(1);
    const lifetime = track(lifetimes[0]!);
    await flush();
    expect(lifetime.settled()).toBe(false);

    read.resolve({ entry: { keyHash: "read-lifetime" } });
    await first;
    await flush();
    expect(lifetime.settled()).toBe(true);

    // The entry was cleared, so the next read goes to storage again.
    await internals.readR2MetadataCached(cacheKey);
    expect(readR2Metadata).toHaveBeenCalledTimes(2);
  });
});
