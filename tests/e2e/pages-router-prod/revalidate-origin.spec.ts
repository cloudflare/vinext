import { createServer, request as sendHttpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

const APP_PORT = 4175;

function requestWithHost(
  host: string,
  path = "/api/revalidate-reason",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = sendHttpRequest(
      {
        hostname: "127.0.0.1",
        port: APP_PORT,
        path,
        headers: { host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("on-demand revalidation uses the bound production server origin", async () => {
  let capturedRevalidateHeader: string | undefined;
  const outsideServer = createServer((request, response) => {
    const header = request.headers["x-prerender-revalidate"];
    capturedRevalidateHeader = Array.isArray(header) ? header[0] : header;
    response.writeHead(418);
    response.end();
  });
  await new Promise<void>((resolve) => outsideServer.listen(0, "127.0.0.1", resolve));

  try {
    const outsidePort = (outsideServer.address() as AddressInfo).port;
    const result = await requestWithHost(`127.0.0.1:${outsidePort}`);

    expect(capturedRevalidateHeader).toBeUndefined();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ revalidated: true });
  } finally {
    await new Promise<void>((resolve, reject) =>
      outsideServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("on-demand revalidation keeps path inputs on the production server origin", async () => {
  let capturedRevalidateHeader: string | undefined;
  const outsideServer = createServer((request, response) => {
    const header = request.headers["x-prerender-revalidate"];
    capturedRevalidateHeader = Array.isArray(header) ? header[0] : header;
    response.writeHead(418);
    response.end();
  });
  await new Promise<void>((resolve) => outsideServer.listen(0, "127.0.0.1", resolve));

  try {
    const outsidePort = (outsideServer.address() as AddressInfo).port;
    const revalidatePath = `//127.0.0.1:${outsidePort}/outside`;
    const result = await requestWithHost(
      `localhost:${APP_PORT}`,
      `/api/revalidate-reason?path=${encodeURIComponent(revalidatePath)}`,
    );

    expect(capturedRevalidateHeader).toBeUndefined();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ revalidated: false });
  } finally {
    await new Promise<void>((resolve, reject) =>
      outsideServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("authenticated on-demand revalidation bypasses Pages middleware", async () => {
  const result = await requestWithHost(
    `localhost:${APP_PORT}`,
    `/api/revalidate-reason?path=${encodeURIComponent("/revalidate-middleware-sentinel")}`,
  );

  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ revalidated: true });
});

// Ported from Next.js: test/e2e/prerender.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/prerender.test.ts
test("only-generated revalidation does not generate an unseen blocking fallback path", async ({
  request,
}) => {
  const slug = `unseen-${Date.now()}`;
  const pathname = `/revalidate-only-generated/${slug}`;
  const result = await requestWithHost(
    `localhost:${APP_PORT}`,
    `/api/revalidate-reason?path=${encodeURIComponent(pathname)}&onlyGenerated=1`,
  );

  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ revalidated: true });

  const firstPageResponse = await request.get(`http://localhost:${APP_PORT}${pathname}`);
  expect(firstPageResponse.status()).toBe(200);
  expect(firstPageResponse.headers()["x-nextjs-cache"]).toBe("MISS");
  const firstPageHtml = await firstPageResponse.text();
  expect(firstPageHtml).toContain("Generated");
  expect(firstPageHtml).toContain(slug);

  const cachedPageResponse = await request.get(`http://localhost:${APP_PORT}${pathname}`);
  expect(cachedPageResponse.headers()["x-nextjs-cache"]).toBe("HIT");
});

test("rejects a nested revalidation from an authenticated loopback", async () => {
  const result = await requestWithHost(
    `localhost:${APP_PORT}`,
    `/api/revalidate-reason?path=${encodeURIComponent("/api/nested-revalidate")}`,
  );

  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ revalidated: false });
});

test("does not reject a forged revalidation-header presence as an internal loopback", async () => {
  const result = await new Promise<{ body: string; status: number }>((resolve, reject) => {
    const request = sendHttpRequest(
      {
        hostname: "127.0.0.1",
        port: APP_PORT,
        path: "/api/nested-revalidate",
        headers: {
          host: `localhost:${APP_PORT}`,
          "x-prerender-revalidate": "forged",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode ?? 0,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });

  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ nestedRejected: false });
});

test("bounds a self-targeting revalidation loop", async () => {
  const startedAt = Date.now();
  const result = await requestWithHost(`localhost:${APP_PORT}`, "/api/nested-revalidate?self=1");

  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ nestedRejected: true });
  expect(Date.now() - startedAt).toBeLessThan(2_000);
});
