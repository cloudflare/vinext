import { expect, test } from "@playwright/test";

// Next.js resolves afterFiles and fallback rewrites and Pages routes before it
// decides whether a multipart POST is a Server Action, and only App pages run
// actions. These routes must receive the body without the action body limit
// or origin check (#3886).
const payload = "x".repeat(1024 * 1024 + 1);

for (const path of ["/after-files-upload", "/fallback-upload"]) {
  test(`delivers multipart POSTs to a route handler reached through ${path}`, async ({
    request,
  }) => {
    const large = await request.post(path, { multipart: { name: payload } });
    expect(large.status()).toBe(202);
    expect(await large.json()).toEqual({ message: "ok", name: payload, email: null });

    const crossOrigin = await request.post(path, {
      headers: { Origin: "https://other.example" },
      multipart: { name: "cross-origin" },
    });
    expect(crossOrigin.status()).toBe(202);
    expect(await crossOrigin.json()).toEqual({ message: "ok", name: "cross-origin", email: null });
  });
}

test("delivers multipart POSTs to a Pages API route in a hybrid app", async ({ request }) => {
  const large = await request.post("/api/multipart-byte-count", { multipart: { name: payload } });
  expect(large.status()).toBe(200);
  expect((await large.json()).bytes).toBeGreaterThan(payload.length);

  const crossOrigin = await request.post("/api/multipart-byte-count", {
    headers: { Origin: "https://other.example" },
    multipart: { name: "cross-origin" },
  });
  expect(crossOrigin.status()).toBe(200);
});

// App pages reached the same ways still run progressive actions with their
// origin check and body limit.
test("checks progressive actions on a page an afterFiles rewrite reaches", async ({ request }) => {
  const crossOrigin = await request.post("/after-rewrite-about", {
    headers: { Origin: "https://other.example" },
    multipart: { name: "cross-origin" },
  });
  expect(crossOrigin.status()).toBe(403);

  // The server answers before reading the rest of the upload, so the
  // connection cannot be reused afterwards.
  const large = await request.post("/after-rewrite-about", {
    headers: { Connection: "close" },
    multipart: { name: payload },
  });
  expect(large.status()).toBe(413);
});

// Middleware overrides request headers on /photos/*, so Pages arbitration runs
// with a header clone first; the dynamic App page still reads the body.
test("checks progressive actions on a dynamic page after Pages arbitration", async ({
  request,
}) => {
  const noAction = await request.post("/photos/1", { multipart: { name: "no action" } });
  expect(noAction.status()).toBe(404);
  expect(noAction.headers()["x-nextjs-action-not-found"]).toBe("1");

  const crossOrigin = await request.post("/photos/1", {
    headers: { Origin: "https://other.example" },
    multipart: { name: "cross-origin" },
  });
  expect(crossOrigin.status()).toBe(403);
});
