import { expect, test, vi } from "vitest";

import type {
  ResponseStoreMutationResult,
  WorkersResponseStore,
} from "@vinext/workers-response-store";
import {
  captureResponseStoreRscData,
  deferResponseStoreAdmission,
  runWithResponseStoreInvocation,
  WorkersResponseStoreCacheHandler,
  type ResponseStoreInvocationCapture,
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

test("captures App page RSC data for one-request warmup", async () => {
  const capture: ResponseStoreInvocationCapture = { captureRscData: true };
  const rscData = new TextEncoder().encode("flight").buffer;

  runWithResponseStoreInvocation(
    "route",
    true,
    () => captureResponseStoreRscData(Promise.resolve(rscData)),
    capture,
  );

  await expect(capture.rscData?.then((body) => new Response(body).text())).resolves.toBe("flight");
});

test("does not retain App page RSC data for ordinary requests", () => {
  const capture: ResponseStoreInvocationCapture = {};

  runWithResponseStoreInvocation(
    "route",
    true,
    () => captureResponseStoreRscData(Promise.resolve(new ArrayBuffer(0))),
    capture,
  );

  expect(capture.rscData).toBeUndefined();
});

test("paces concurrent admission with each foreground consumer", async () => {
  const pulls = [0, 0];
  const captures: ResponseStoreInvocationCapture[] = [
    { streamResponse: true },
    { streamResponse: true },
  ];
  const foreground = captures.map((capture, index) =>
    runWithResponseStoreInvocation(
      `route-${index}`,
      true,
      () =>
        deferResponseStoreAdmission(
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  pulls[index]++;
                  controller.enqueue(new Uint8Array([pulls[index]]));
                  if (pulls[index] === 2) controller.close();
                },
              },
              { highWaterMark: 0 },
            ),
          ),
          async (response) => new Response(await response.arrayBuffer()),
        ),
      capture,
    ),
  );

  await Promise.resolve();
  expect(pulls).toEqual([0, 0]);

  const readers = foreground.map((response) => response?.body?.getReader());
  expect((await readers[0]?.read())?.value).toEqual(new Uint8Array([1]));
  await Promise.resolve();
  expect(pulls).toEqual([1, 0]);

  expect((await readers[1]?.read())?.value).toEqual(new Uint8Array([1]));
  expect((await readers[0]?.read())?.value).toEqual(new Uint8Array([2]));
  expect((await readers[1]?.read())?.value).toEqual(new Uint8Array([2]));
  await Promise.all(readers.map(async (reader) => reader?.read()));
  await Promise.all(captures.map(async (capture) => capture.admittedResponse));
});

test("continues the foreground stream when admission rejects without reading", async () => {
  const capture: ResponseStoreInvocationCapture = { streamResponse: true };
  const chunks = ["first", "second"];
  const foreground = runWithResponseStoreInvocation(
    "route",
    true,
    () =>
      deferResponseStoreAdmission(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                controller.enqueue(new TextEncoder().encode(chunks.shift()));
                if (chunks.length === 0) controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
        ),
        async () => {
          throw new Error("admission failed");
        },
      ),
    capture,
  );

  await expect(capture.admittedResponse).rejects.toThrow("admission failed");
  await expect(foreground?.text()).resolves.toBe("firstsecond");
});

test.each(["rejects", "is cancelled"] as const)(
  "cancels a blocked source when foreground stops and admission %s",
  async (admissionFailure) => {
    const capture: ResponseStoreInvocationCapture = { streamResponse: true };
    let resolvePullStarted!: () => void;
    const pullStarted = new Promise<void>((resolve) => {
      resolvePullStarted = resolve;
    });
    let rejectAdmission!: (reason: unknown) => void;
    const rejectedAdmission = new Promise<Response>((_resolve, reject) => {
      rejectAdmission = reject;
    });
    let cancelReason: unknown;
    const foreground = runWithResponseStoreInvocation(
      "route",
      true,
      () =>
        deferResponseStoreAdmission(
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull() {
                  resolvePullStarted();
                  return new Promise(() => {});
                },
                cancel(reason) {
                  cancelReason = reason;
                },
              },
              { highWaterMark: 0 },
            ),
          ),
          (response) =>
            admissionFailure === "rejects" ? rejectedAdmission : Promise.resolve(response),
        ),
      capture,
    );

    await foreground?.body?.cancel("visitor left");
    await pullStarted;
    if (admissionFailure === "rejects") {
      rejectAdmission(new Error("admission failed"));
      await expect(capture.admittedResponse).rejects.toThrow("admission failed");
    } else {
      const admitted = await capture.admittedResponse;
      await admitted?.body?.cancel();
    }
    expect(cancelReason).toBe("visitor left");
  },
);

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
