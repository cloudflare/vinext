import { describe, expect, it, vi } from "vite-plus/test";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { createCloudflareFetchAdapter } from "../packages/vinext/src/server/cloudflare-fetch-adapter.js";

type WorkersRequestInit = RequestInit & {
  encodeResponseBody?: "automatic" | "manual";
};

function responseWithMetadata(
  body: BodyInit,
  contentEncoding: string,
  url = "https://api.example.com/final",
): Response {
  const response = new Response(body, {
    headers: {
      "content-encoding": contentEncoding,
      "content-length": String(body instanceof Uint8Array ? body.byteLength : 0),
      "content-type": "application/json",
    },
  });
  Object.defineProperties(response, {
    url: { value: url, configurable: true, enumerable: true },
    redirected: { value: true, configurable: true, enumerable: true },
    type: { value: "default", configurable: true, enumerable: true },
    cf: { value: { colo: "LHR" }, configurable: true, enumerable: true },
  });
  return response;
}

describe("Cloudflare fetch adapter", () => {
  it("decodes the complete content-encoding chain and preserves fetch metadata", async () => {
    const payload = { timestamp: 1_787_056_318 };
    const compressed = brotliCompressSync(gzipSync(JSON.stringify(payload)));
    const source = responseWithMetadata(compressed, "gzip, br");
    const originalFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => source,
    );
    const runtimeFetch = createCloudflareFetchAdapter(originalFetch);

    const response = await runtimeFetch("https://api.example.com/redirect");

    expect(originalFetch).toHaveBeenCalledWith(
      "https://api.example.com/redirect",
      expect.objectContaining({
        encodeResponseBody: "manual",
        headers: expect.any(Headers),
      }),
    );
    expect(new Headers(originalFetch.mock.calls[0]?.[1]?.headers).get("accept-encoding")).toBe(
      "gzip, deflate",
    );
    expect(response.headers).not.toBe(source.headers);
    expect(response.headers.get("content-encoding")).toBe("gzip, br");
    expect(response.headers.get("content-length")).toBe(String(compressed.byteLength));
    response.headers.set("x-test", "response");
    expect(response.headers.get("x-test")).toBe("response");
    expect(response.url).toBe(source.url);
    expect(response.redirected).toBe(true);
    expect(response.type).toBe("basic");
    expect(Reflect.get(response, "cf")).toEqual({ colo: "LHR" });
    const cloned = response.clone();
    expect(cloned.headers).not.toBe(response.headers);
    cloned.headers.set("x-test", "clone");
    expect(cloned.headers.get("x-test")).toBe("clone");
    expect(response.headers.get("x-test")).toBe("response");
    expect(cloned.url).toBe(source.url);
    expect(cloned.redirected).toBe(true);
    expect(cloned.type).toBe("basic");
    expect(Reflect.get(cloned, "cf")).toEqual({ colo: "LHR" });
    expect(Reflect.get(cloned, "cf")).not.toBe(Reflect.get(response, "cf"));
    await expect(Promise.all([response.json(), cloned.json()])).resolves.toEqual([
      payload,
      payload,
    ]);
  });

  it.each([
    {
      name: "repeated gzip codings",
      encoding: "gzip, gzip",
      body: (value: string) => gzipSync(gzipSync(value)),
    },
    {
      name: "concatenated gzip members",
      encoding: "gzip",
      body: (value: string) =>
        Buffer.concat([gzipSync(value.slice(0, 5)), gzipSync(value.slice(5))]),
    },
  ])("decodes $name like Node fetch", async ({ encoding, body }) => {
    const json = JSON.stringify({ ok: true });
    const originalFetch = vi.fn(async () => responseWithMetadata(body(json), encoding));
    const runtimeFetch = createCloudflareFetchAdapter(originalFetch);

    await expect((await runtimeFetch("https://api.example.com/data")).json()).resolves.toEqual({
      ok: true,
    });
  });

  it("resolves at headers without pulling the encoded body", async () => {
    const compressed = gzipSync(JSON.stringify({ delayed: true }));
    let pulled = false;
    let release: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          return new Promise<void>((resolve) => {
            release = () => {
              controller.enqueue(compressed);
              controller.close();
              resolve();
            };
          });
        },
      },
      { highWaterMark: 0 },
    );
    const originalFetch = vi.fn(async () => responseWithMetadata(body, "gzip"));
    const runtimeFetch = createCloudflareFetchAdapter(originalFetch);

    const response = await runtimeFetch("https://api.example.com/slow");
    expect(pulled).toBe(false);

    const data = response.json();
    await vi.waitFor(() => expect(pulled).toBe(true));
    release?.();
    await expect(data).resolves.toEqual({ delayed: true });
  });

  it("cancels an unconsumed origin body without starting decompression", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          return new Promise(() => {});
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const originalFetch = vi.fn(async () => responseWithMetadata(body, "gzip"));
    const runtimeFetch = createCloudflareFetchAdapter(originalFetch);

    const response = await runtimeFetch("https://api.example.com/stalled");
    await response.body?.cancel("caller stopped");

    expect(cancel).toHaveBeenCalledWith("caller stopped");
  });

  it("decodes caller-supplied Accept-Encoding like Node fetch", async () => {
    const payload = { callerSelected: true };
    const compressed = gzipSync(JSON.stringify(payload));
    const source = responseWithMetadata(compressed, "gzip");
    const originalFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => source,
    );
    const runtimeFetch = createCloudflareFetchAdapter(originalFetch);
    const init = { headers: { "accept-encoding": "gzip" } };

    const response = await runtimeFetch("https://api.example.com/archive.json", init);

    expect(new Headers(originalFetch.mock.calls[0]?.[1]?.headers).get("accept-encoding")).toBe(
      "gzip",
    );
    expect(originalFetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ encodeResponseBody: "manual" }),
    );
    await expect(response.json()).resolves.toEqual(payload);
  });

  it("honors the Workers manual response-body mode", async () => {
    const compressed = gzipSync(JSON.stringify({ manual: true }));
    const source = responseWithMetadata(compressed, "gzip");
    const originalFetch = vi.fn(async () => source);
    const runtimeFetch = createCloudflareFetchAdapter(originalFetch);
    const init: WorkersRequestInit = { encodeResponseBody: "manual" };

    const response = await runtimeFetch("https://api.example.com/manual", init);

    expect(originalFetch).toHaveBeenCalledWith("https://api.example.com/manual", init);
    expect(response).toBe(source);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(compressed));
  });
});
