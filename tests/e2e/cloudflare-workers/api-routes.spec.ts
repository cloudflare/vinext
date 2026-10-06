import { request as httpRequest } from "node:http";
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4176";

// Playwright's request context won't frame a GET body, so use node:http. Send an
// empty chunked body: wrangler dev's proxy drops `Content-Length: 0`, and body bytes
// the Worker never reads can make the proxy's forwarding fetch fail, which takes
// wrangler dev down.
function sendFramed(
  method: "GET" | "HEAD",
  path: string,
): Promise<{
  body: string;
  headers: Record<string, string | string[] | undefined>;
  status: number;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "localhost", port: 4176, path, method, headers: { "transfer-encoding": "chunked" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ body, headers: res.headers, status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test.describe("Cloudflare Workers API Routes", () => {
  test("GET /api/hello returns JSON", async ({ request }) => {
    const response = await request.get(`${BASE}/api/hello`);

    expect(response.status()).toBe(200);
    const json = await response.json();
    expect(json.message).toBe("Hello from vinext on Cloudflare Workers!");
  });

  test("API route reports Cloudflare-Workers runtime", async ({ request }) => {
    const response = await request.get(`${BASE}/api/hello`);
    const json = await response.json();

    expect(json.runtime).toBe("Cloudflare-Workers");
  });

  test("API route returns proper content-type", async ({ request }) => {
    const response = await request.get(`${BASE}/api/hello`);
    const contentType = response.headers()["content-type"];

    expect(contentType).toContain("application/json");
  });

  // Ported from Next.js: test/e2e/edge-can-use-wasm-files/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-can-use-wasm-files/index.test.ts
  test("API route can use a wasm module", async ({ request }) => {
    const response = await request.get(`${BASE}/api/wasm`);

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ result: 42 });
  });

  // Workers gives a GET/HEAD with body framing (Content-Length or Transfer-Encoding)
  // a non-null body, even an empty one. Next.js nulls GET/HEAD bodies before user
  // code runs (NextRequestAdapter), so middleware, route handlers and edge API routes
  // must all see a null body, and rebuilding the route handler's request must not throw.
  test("a framed GET reaches user code with a null body", async () => {
    const response = await sendFramed("GET", "/api/framed-get");

    expect(response.status).toBe(200);
    expect(response.headers["x-mw-body-null"]).toBe("true");
    expect(JSON.parse(response.body)).toEqual({
      bodyNull: true,
      requestBodyNull: true,
      nextRequestBodyNull: true,
    });
  });

  test("a framed HEAD reaches the route handler with a null body", async () => {
    const response = await sendFramed("HEAD", "/api/framed-get");

    expect(response.status).toBe(200);
    expect(response.headers["x-mw-body-null"]).toBe("true");
    expect(response.headers["x-route-body-null"]).toBe("true");
  });

  test("a framed GET reaches an edge API route with a null body", async () => {
    const response = await sendFramed("GET", "/api/framed-get-edge");

    expect(response.status).toBe(200);
    expect(response.headers["x-mw-body-null"]).toBe("true");
    expect(JSON.parse(response.body)).toEqual({ bodyNull: true });
  });
});
