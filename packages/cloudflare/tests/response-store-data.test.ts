import { expect, test, vi } from "vitest";

import type {
  ResponseStoreMutationResult,
  WorkersResponseStore,
} from "@vinext/workers-response-store";
import {
  runWithResponseStoreInvocation,
  WorkersResponseStoreCacheHandler,
} from "../src/cache/response-store-data.runtime";

class TestStore implements WorkersResponseStore {
  response?: Response;
  options?: Parameters<WorkersResponseStore["put"]>[2];
  putResult: ResponseStoreMutationResult = {
    backingStoreUpdated: true,
    edgePurgeAccepted: true,
  };
  mutationResult = this.putResult;
  mutationError?: Error;

  async fetch(): Promise<Response> {
    return (
      this.response?.clone() ??
      new Response("miss", {
        status: 404,
        headers: { "X-Workers-Response-Store": "MISS" },
      })
    );
  }

  async put(
    _request: Request,
    response: Response,
    options?: Parameters<WorkersResponseStore["put"]>[2],
  ): Promise<ResponseStoreMutationResult> {
    if (this.mutationError) throw this.mutationError;
    this.response = response.clone();
    this.options = options;
    return this.putResult;
  }

  async refresh(): Promise<ResponseStoreMutationResult> {
    if (this.mutationError) throw this.mutationError;
    return this.mutationResult;
  }

  async purge(): Promise<ResponseStoreMutationResult> {
    if (this.mutationError) throw this.mutationError;
    return this.mutationResult;
  }
}

test("only attaches loopback regeneration to replayable requests", async () => {
  const store = new TestStore();
  const handler = new WorkersResponseStoreCacheHandler(store);

  await runWithResponseStoreInvocation("safe-get", true, () =>
    handler.set("get", null, { cacheControl: { revalidate: 1, expire: 2 } }),
  );
  expect(store.options).toMatchObject({
    purgeExisting: true,
    revalidator: { id: "vinext:data", args: ["get", "safe-get"] },
  });
  expect(store.response?.headers.get("X-Vinext-Response-Store-Replayable")).toBe("1");

  await runWithResponseStoreInvocation("unsafe-post", false, () =>
    handler.set("post", null, { cacheControl: { revalidate: 1, expire: 2 } }),
  );
  expect(store.options).toEqual({ purgeExisting: true });
  expect(store.response?.headers.get("X-Vinext-Response-Store-Replayable")).toBeNull();
  expect(store.response?.headers.get("Cache-Control")).toBe("public, max-age=315360000");
});

test("prefers a cache function invocation over route replay", async () => {
  const store = new TestStore();
  const invocation = {
    encryptedArgs: "encrypted",
    referenceId: "module#cached",
    rootParams: {},
    softTags: ["path-tag"],
  };

  await runWithResponseStoreInvocation("route", true, () =>
    new WorkersResponseStoreCacheHandler(store).set("key", null, {
      cacheControl: { revalidate: 1, expire: 2 },
      cacheFunctionInvocation: invocation,
    }),
  );

  expect(store.options?.revalidator).toEqual({
    id: "vinext:cache-function",
    args: ["key", JSON.stringify(invocation)],
  });
});

test("treats a superseded write as a successful no-op", async () => {
  const store = new TestStore();
  store.putResult = { backingStoreUpdated: false, edgePurgeAccepted: false };
  await expect(
    new WorkersResponseStoreCacheHandler(store).set("key", null),
  ).resolves.toBeUndefined();
});

test("honors a shorter revalidate requested by a later read", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(10_000);
    const store = new TestStore();
    const handler = new WorkersResponseStoreCacheHandler(store);
    await handler.set("key", null, { cacheControl: { revalidate: 60, expire: 120 } });

    vi.setSystemTime(12_000);
    await expect(handler.get("key", { revalidate: 1 })).resolves.toMatchObject({
      cacheState: "stale",
    });
  } finally {
    vi.useRealTimers();
  }
});

test("propagates mutation errors without treating an unavailable local edge cache as fatal", async () => {
  const store = new TestStore();
  store.putResult = { backingStoreUpdated: true, edgePurgeAccepted: false };
  const handler = new WorkersResponseStoreCacheHandler(store);
  await expect(handler.set("key", null)).resolves.toBeUndefined();

  store.mutationResult = { backingStoreUpdated: false, edgePurgeAccepted: false };
  await expect(handler.revalidateTag("missing", { expire: 60 })).resolves.toBeUndefined();

  store.mutationError = new Error("edge purge failed");
  await expect(handler.set("key", null)).rejects.toThrow("edge purge failed");
  await expect(handler.revalidateTag("posts", { expire: 60 })).rejects.toThrow("edge purge failed");
});
