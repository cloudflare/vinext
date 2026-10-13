import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";

const BASE = "http://localhost:4174";

type CachedOrigin = {
  body: { caseId: string; visibility: string };
  originRequestId: string;
};

async function readCase(
  request: APIRequestContext,
  caseId: string,
  visibility: string,
): Promise<CachedOrigin> {
  const response = await request.get(
    `${BASE}/api/fetch-cache-iterable-body?case=${caseId}&visibility=${visibility}`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as CachedOrigin;
}

test("cached POSTs with different async iterable bodies get separate data cache entries", async ({
  request,
}) => {
  const caseId = randomUUID();

  // Read until the private response is served from the data cache, so the
  // public read below would find it if both bodies shared a key.
  let privateEntry: CachedOrigin | undefined;
  await expect
    .poll(async () => {
      const read = await readCase(request, caseId, "private");
      expect(read.body).toEqual({ caseId, visibility: "private" });
      const servedFromCache = read.originRequestId === privateEntry?.originRequestId;
      privateEntry = read;
      return servedFromCache;
    })
    .toBe(true);

  const publicRead = await readCase(request, caseId, "public");
  expect(publicRead.body).toEqual({ caseId, visibility: "public" });
  expect(publicRead.originRequestId).not.toBe(privateEntry?.originRequestId);
});
