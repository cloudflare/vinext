import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";

let externalRewriteServer: Server;

test.beforeAll(async () => {
  externalRewriteServer = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        pathname: new URL(request.url ?? "/", "http://127.0.0.1:4231").pathname,
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    externalRewriteServer.once("error", reject);
    externalRewriteServer.listen(4231, "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    externalRewriteServer.close((error) => (error ? reject(error) : resolve()));
  });
});

test("external catch-all rewrites preserve their destination path prefix", async ({ request }) => {
  const normal = await request.get("/external-prefix/resource");
  expect(normal.status()).toBe(200);
  await expect(normal.json()).resolves.toEqual({ pathname: "/v1/resource" });

  for (const pathname of ["%252e%252e", ".%252e", "%252e."]) {
    const traversal = await request.get(`/external-prefix/${pathname}/outside`);
    expect(traversal.status()).toBe(200);
    const traversalResult = (await traversal.json()) as { pathname: string };
    expect(traversalResult.pathname).toMatch(/^\/v1(?:\/|$)/);
  }

  expect((await request.get("/external-prefix../outside")).status()).toBe(404);
});
