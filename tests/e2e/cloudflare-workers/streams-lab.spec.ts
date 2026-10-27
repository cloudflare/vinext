import { createHash, randomBytes, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../fixtures";

// Stream patterns Next.js apps use, run on the TypeScript Web Streams
// implementation that the typescript_implemented_streams flag enables.
// Routes: examples/app-router-cloudflare/app/api/streams-lab and app/streams-lab.

function baseURL(): string {
  return test.info().project.use.baseURL ?? "http://localhost:4176";
}

function deployed(): boolean {
  return !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(baseURL());
}

async function runsTypeScriptStreams(request: APIRequestContext): Promise<boolean> {
  return (await (await request.get("/api/streams-lab/impl")).json()).typescript === true;
}

// workerd bugs these tests found, reproduced without vinext. Each test is
// expected to fail while the Worker runs the TypeScript implementation, so a
// workerd fix turns it red.
const FORM_DATA_BUG =
  "workerd: Body.formData() reads the body through consumeReadableStreamAsText, so binary file parts are UTF-8 decoded";
const DISCONNECT_BUG =
  "workerd: a client disconnect never calls the response stream source's cancel()";

function pattern(length: number): Buffer {
  const buffer = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buffer[i] = i % 251;
  return buffer;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

test.describe("Web Streams lab", () => {
  test("the Worker runs the TypeScript streams implementation", async ({ request }) => {
    const get = await (await request.get("/api/streams-lab/impl")).json();
    expect(get, JSON.stringify(get)).toMatchObject({
      typescript: true,
      nativeClasses: [],
      missingOrInherited: [],
      instances: {
        blobStream: true,
        responseBody: true,
        fetchBody: true,
        nodeStreamWebIsGlobal: true,
        compressionExtendsTransform: false,
      },
    });

    const post = await (
      await request.post("/api/streams-lab/impl", { data: "request body" })
    ).json();
    expect(post.instances.requestBody).toBe(true);
    expect(post.typescript).toBe(true);
  });

  test("in-Worker stream usage checks pass", async ({ request }) => {
    const results = (await (await request.get("/api/streams-lab/checks")).json()) as Record<
      string,
      { kind: string; ok: boolean; value?: unknown; error?: string }
    >;
    const failures = Object.entries(results).filter(
      ([, result]) => result.kind === "usage" && !result.ok,
    );
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);

    const divergences = Object.fromEntries(
      Object.entries(results)
        .filter(([, result]) => result.kind === "divergence")
        .map(([name, result]) => [name, result.ok ? result.value : result.error]),
    );
    // Spec behaviour the C++ implementation did not have (workerd divergence ledgers).
    expect(divergences, JSON.stringify(divergences, null, 2)).toMatchObject({
      syncStartThrow: "constructor threw Error: start failed",
      transformInfinityHighWaterMark: "accepted",
      invalidHighWaterMark: expect.stringMatching(/^threw RangeError/),
      teeCancelBothReasons: 'AggregateError ["left","right"]',
      stringChunkIntoCompressionStream: expect.stringMatching(/^rejected: TypeError/),
      fixedLengthOverflow: expect.stringMatching(/^rejected: RangeError/),
      secondConcurrentCompressionRead: "pending",
    });
  });

  test("streamed response bodies arrive intact", async ({ request }) => {
    const sse = await request.get("/api/streams-lab/sse");
    expect(sse.headers()["content-type"]).toContain("text/event-stream");
    const events = (await sse.text()).split("\n\n").filter(Boolean);
    expect(events).toHaveLength(30);
    expect(events[29]).toBe('id: 29\ndata: {"n":29}');

    expect(await (await request.get("/api/streams-lab/tiny")).text()).toBe("one byte at a time ✓");

    const byteBody = await (await request.get("/api/streams-lab/byte-body")).body();
    expect(byteBody.equals(pattern(256 * 1024))).toBe(true);

    const generated = await (await request.get("/api/streams-lab/generator")).text();
    expect(generated.split("\n")).toHaveLength(1001);
    expect(generated.endsWith("line 999\n")).toBe(true);

    const gzip = gunzipSync(await (await request.get("/api/streams-lab/gzip")).body());
    expect(gzip.byteLength).toBe(1024 * 1024);
    expect(gzip.subarray(0, 16).toString()).toBe("compress me now ");

    const big = await (await request.get("/api/streams-lab/big")).body();
    expect(big.byteLength).toBe(10 * 1024 * 1024);
    expect(sha256(big)).toBe(sha256(pattern(10 * 1024 * 1024)));

    const fixed = await request.get("/api/streams-lab/fixed-length");
    expect((await fixed.body()).equals(pattern(3 * 1024 * 1024))).toBe(true);

    const nodeReadable = await (await request.get("/api/streams-lab/node-readable")).text();
    expect(nodeReadable.split("\n")).toHaveLength(51);

    const nextResponse = await request.get("/api/streams-lab/nextresponse");
    expect(await nextResponse.text()).toBe("nextresponse");
    expect(nextResponse.headers()["set-cookie"]).toContain("streams-lab=1");

    const pagesWrite = await (await request.get("/api/streams-lab-write")).text();
    expect(pagesWrite.split("\n")).toHaveLength(22);
    expect(pagesWrite.endsWith("chunk 19 ✓\ndone\n")).toBe(true);
  });

  test("native bodies pass through and are proxied", async ({ request }) => {
    const direct = await (await request.get("/api/streams-lab/assets-direct")).body();
    const proxied = await (await request.get("/api/streams-lab/assets-proxy")).body();
    const asset = await (await request.get("/vinext-image.png")).body();
    expect(direct.byteLength).toBeGreaterThan(0);
    expect(direct.equals(asset)).toBe(true);
    expect(proxied.equals(asset)).toBe(true);
  });

  test("request bodies stream through tee, clone and transforms", async () => {
    // Node's fetch streams the body in chunks, as a browser upload would.
    const text = "streaming request body ünïcödé ".repeat(2000);
    const chunks = Buffer.from(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < chunks.byteLength; i += 997)
          controller.enqueue(chunks.subarray(i, i + 997));
        controller.close();
      },
    });
    const echo = await fetch(`${baseURL()}/api/streams-lab/echo`, {
      method: "POST",
      body,
      // @ts-expect-error duplex is required for stream bodies but missing from DOM types.
      duplex: "half",
    });
    expect(echo.status).toBe(200);
    expect(await echo.text()).toBe(text.toUpperCase());

    const upload = randomBytes(2 * 1024 * 1024);
    const tee = await fetch(`${baseURL()}/api/streams-lab/tee-request`, {
      method: "POST",
      body: upload,
    });
    expect(await tee.json()).toEqual({
      first: sha256(upload),
      second: sha256(upload),
      clonedBytes: upload.byteLength,
    });
  });

  test("multipart uploads stream through file.stream()", async ({ request }) => {
    test.fail(await runsTypeScriptStreams(request), FORM_DATA_BUG);
    const file = randomBytes(1024 * 1024 + 17);
    const response = await request.post("/api/streams-lab/formdata", {
      multipart: {
        field: "value",
        file: { name: "upload.bin", mimeType: "application/octet-stream", buffer: file },
      },
    });
    expect(await response.json()).toEqual({
      name: "upload.bin",
      size: file.byteLength,
      field: "value",
      sha256: sha256(file),
    });
  });

  test("an error after the body started truncates the response", async ({ request }) => {
    let text = "";
    try {
      text = await (await request.get("/api/streams-lab/error-mid")).text();
    } catch {
      // The connection can be reset instead; either way the Worker keeps serving.
    }
    expect(text === "" || text.startsWith("before the error")).toBe(true);
    expect((await request.get("/api/hello")).status()).toBe(200);
  });

  test("a client abort mid-stream leaves the Worker serving", async ({ request }) => {
    const controller = new AbortController();
    const response = await fetch(`${baseURL()}/api/streams-lab/cancel?token=${randomUUID()}`, {
      // A gzip-encoded response holds small chunks back until it has enough to compress.
      headers: { "accept-encoding": "identity" },
      signal: controller.signal,
    });
    const first = await response.body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("tick 0");
    controller.abort();
    expect((await request.get("/api/hello")).status()).toBe(200);
  });

  test("a client disconnect cancels the response stream", async ({ request }) => {
    // Deployed requests can land on different isolates, so only a local run can
    // read the cancellation back.
    test.skip(deployed(), "needs one isolate");
    test.fail(await runsTypeScriptStreams(request), DISCONNECT_BUG);
    const token = randomUUID();
    const controller = new AbortController();
    const response = await fetch(`${baseURL()}/__streams-lab/disconnect?token=${token}`, {
      // A gzip-encoded response holds small chunks back until it has enough to compress.
      headers: { "accept-encoding": "identity" },
      signal: controller.signal,
    });
    await response.body!.getReader().read();
    controller.abort();
    await expect
      .poll(
        async () =>
          (await (await request.get(`/__streams-lab/disconnect-status?token=${token}`)).json())
            .cancelled,
        { timeout: 5_000 },
      )
      .toBe(true);
  });

  test("Suspense boundaries, stream props and use() stream into the page", async ({
    page,
    consoleErrors,
  }) => {
    await page.goto("/streams-lab");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      "streams lab",
    );
    for (let i = 0; i < 20; i++) {
      await expect(page.getByTestId(`boundary-${i}`)).toContainText(`boundary ${i} after`);
    }
    await expect(page.getByTestId("nested-bottom")).toHaveText("bottom");
    await expect(page.getByTestId("stream-prop")).toHaveText("streamed through flight");
    await expect(page.getByTestId("use-promise")).toHaveText("resolved through use()");
    expect(consoleErrors).toEqual([]);
  });

  test("a server action reads an uploaded file through file.stream()", async ({
    page,
    request,
    consoleErrors,
  }) => {
    test.fail(await runsTypeScriptStreams(request), FORM_DATA_BUG);
    const file = randomBytes(512 * 1024);
    await page.goto("/streams-lab/upload");
    await page.waitForLoadState("networkidle");
    await page
      .getByTestId("upload-file")
      .setInputFiles({ name: "upload.bin", mimeType: "application/octet-stream", buffer: file });
    await page.getByRole("button", { name: "upload" }).click();
    await expect(page.getByTestId("upload-result")).toHaveText(
      `${file.byteLength} ${sha256(file)}`,
    );
    expect(consoleErrors).toEqual([]);
  });
});
