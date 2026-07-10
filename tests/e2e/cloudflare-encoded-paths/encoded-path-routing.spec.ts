import { expect, test } from "@playwright/test";
import { request as httpRequest } from "node:http";

function getRawPath(path: string): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", path, port: 4197 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ body, status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("keeps lazy Route Handler params stable across first and later Worker requests", async ({
  request,
}) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await request.get("/encoded-parity/handler/a%2561/b%2Fc");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ path: ["a%61", "b/c"] });
  }

  const optional = await request.get("/encoded-parity/handler");
  expect(await optional.json()).toEqual({ path: null });
});

test("keeps direct and middleware-rewritten Worker App Page params canonical", async ({
  request,
}) => {
  for (const pathname of [
    "/encoded-parity/page/a%2561/b%2Fc",
    "/encoded-parity/rewrite/a%2561/b%2Fc",
  ]) {
    const response = await request.get(pathname);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('["a%2561","b%2Fc"]');
  }
});

test("enforces canonical dynamicParams=false values on Workers", async () => {
  const allowed = await getRawPath("/encoded-parity/static/a%252Fb");
  expect(allowed.status).toBe(200);
  expect(allowed.body).toContain("a%252Fb");

  const alias = await getRawPath("/encoded-parity/static/a%2Fb");
  expect(alias.status).toBe(404);
});

test("honors explicit normalized-equal Worker middleware rewrites", async () => {
  const implicitAlias = await getRawPath("/%61bout");
  expect(implicitAlias.status).toBe(404);

  const rewritten = await getRawPath("/%61dmin");
  expect(rewritten.status).toBe(200);
  expect(rewritten.body).toContain("Worker admin content");
});
