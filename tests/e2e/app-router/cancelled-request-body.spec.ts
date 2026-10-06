import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4174";

// Node's Readable.toWeb() adapter (used for request bodies in dev) throws an
// uncaught ERR_INVALID_STATE when a body is cancelled while chunks are still
// buffered. Cancelling large bodies must not take the dev server down.
test("cancelling a request body does not crash the dev server", async ({ request }) => {
  const body = Buffer.alloc(3 * 1024 * 1024, 97);
  const responses = await Promise.all(
    Array.from({ length: 10 }, () =>
      request.post(`${BASE}/api/cancel-request-body`, {
        data: body,
        headers: { "content-type": "application/octet-stream" },
      }),
    ),
  );
  for (const response of responses) expect(response.status()).toBe(200);

  // Cancelling a body destroys its socket, and Playwright's shared connection
  // pool can hand that dead socket to the next request, so check health with
  // a separate client.
  const health = await fetch(`${BASE}/api/hello`);
  expect(health.status).toBe(200);
});
