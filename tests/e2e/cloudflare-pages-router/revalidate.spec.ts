import { createServer, request as sendHttpRequest, type Server } from "node:http";
import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4177";

function extractToken(html: string): string {
  const match = html.match(/<p id="revalidate-token">([^<]+)<\/p>/);
  if (!match) throw new Error("Missing revalidation token");
  return match[1];
}

async function requestWithHost(
  host: string,
  path: string,
): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const request = sendHttpRequest(
      {
        hostname: "127.0.0.1",
        port: 4177,
        path,
        headers: { host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("revalidates inside the Worker without sending its credential to the request origin", async ({
  request,
}) => {
  const capturedHeaders: Array<string | undefined> = [];
  const outsideServer = createServer((incoming, response) => {
    const value = incoming.headers["x-prerender-revalidate"];
    capturedHeaders.push(Array.isArray(value) ? value[0] : value);
    response.writeHead(200);
    response.end("outside");
  });
  await new Promise<void>((resolve) => outsideServer.listen(0, "127.0.0.1", resolve));
  const address = outsideServer.address();
  if (!address || typeof address === "string") throw new Error("Expected outside TCP server");

  try {
    const before = await request.get(`${BASE}/revalidate-target`);
    expect(before.status()).toBe(200);
    const beforeToken = extractToken(await before.text());

    const result = await requestWithHost(
      `127.0.0.1:${address.port}`,
      `/api/revalidate?path=${encodeURIComponent("/revalidate-target")}`,
    );
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ revalidated: true });
    expect(capturedHeaders).toEqual([]);

    const after = await request.get(`${BASE}/revalidate-target`);
    expect(after.status()).toBe(200);
    expect(extractToken(await after.text())).not.toBe(beforeToken);
  } finally {
    await closeServer(outsideServer);
  }
});

test("rejects nested Worker revalidation without contaminating concurrent requests", async ({
  request,
}) => {
  const [nested, ...concurrent] = await Promise.all([
    request.get(`${BASE}/api/revalidate?path=${encodeURIComponent("/api/nested-revalidate")}`),
    ...Array.from({ length: 4 }, () =>
      request.get(`${BASE}/api/revalidate?path=${encodeURIComponent("/revalidate-target")}`),
    ),
  ]);

  expect(nested.status()).toBe(500);
  expect(await nested.json()).toEqual({ revalidated: false });
  for (const response of concurrent) {
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ revalidated: true });
  }

  const startedAt = Date.now();
  const selfTarget = await request.get(`${BASE}/api/nested-revalidate?self=1`);
  expect(selfTarget.status()).toBe(200);
  expect(await selfTarget.json()).toEqual({ nestedRejected: true });
  expect(Date.now() - startedAt).toBeLessThan(2_000);
});

test("does not expose Worker revalidation internals to userland or external rewrites", async ({
  request,
}) => {
  const sentinel = await request.get(
    `${BASE}/api/revalidate?path=${encodeURIComponent("/api/revalidation-host-sentinel")}`,
  );
  expect(sentinel.status()).toBe(200);
  expect(await sentinel.json()).toEqual({ revalidated: true });

  const captures: Array<{
    logicalHost: string | undefined;
    onlyGenerated: string | undefined;
    secret: string | undefined;
  }> = [];
  const outsideServer = createServer((incoming, response) => {
    const read = (name: string): string | undefined => {
      const value = incoming.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    captures.push({
      logicalHost: read("x-vinext-revalidate-host"),
      onlyGenerated: read("x-prerender-revalidate-if-generated"),
      secret: read("x-prerender-revalidate"),
    });
    response.writeHead(200);
    response.end("outside");
  });
  await new Promise<void>((resolve) => outsideServer.listen(43199, "127.0.0.1", resolve));

  try {
    const proxy = await request.get(
      `${BASE}/api/revalidate?path=${encodeURIComponent("/external-revalidate-proxy")}&onlyGenerated=1`,
    );
    expect(proxy.status()).toBe(200);
    expect(await proxy.json()).toEqual({ revalidated: true });
    expect(captures).toEqual([
      { logicalHost: undefined, onlyGenerated: undefined, secret: undefined },
    ]);
  } finally {
    await closeServer(outsideServer);
  }
});
