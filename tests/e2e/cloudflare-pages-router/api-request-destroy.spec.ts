import { expect, test } from "@playwright/test";
import { postStalledUpload } from "../helpers";

const BASE = "http://localhost:4177";

// wrangler dev only forwards the response once the upload ends, so the handler
// reports how long close took instead of the client observing an early reply.
test("Pages API req.destroy() emits close while the upload is stalled on Workers", async () => {
  const response = await postStalledUpload(BASE, "/api/destroy-upload", 1000);
  expect(response.status).toBe(413);
  expect(JSON.parse(response.body).closeMs).toBeLessThan(500);
});
