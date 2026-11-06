import { expect, test } from "@playwright/test";
import { postStalledUpload } from "../helpers";

const BASE = "http://localhost:4175";

// Node IncomingMessage emits close as soon as a raw-body handler destroys it,
// without waiting for the client to send more of the upload.
test("Pages API req.destroy() emits close while the upload is stalled", async () => {
  const response = await postStalledUpload(BASE, "/api/destroy-upload", 1000);
  expect(response.status).toBe(413);
  expect(JSON.parse(response.body).closeMs).toBeLessThan(500);
});
