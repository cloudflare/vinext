import { expect, test } from "@playwright/test";

// One Worker can serve several custom domains through a single path-keyed ISR
// cache. A route handler that selects data by hostname must never replay one
// host's stored response on another.
test("keeps a hostname-selected route handler response off other Worker hosts", async ({
  request,
  baseURL,
}) => {
  const port = new URL(baseURL ?? "http://localhost:4197").port;
  const tenants = ["tenant-a", "tenant-b", "tenant-a", "tenant-b"];
  const responses = [];
  for (const tenant of tenants) {
    const response = await request.get("/api/host-tenant", {
      headers: { host: `${tenant}.localhost:${port}` },
    });
    expect(response.status()).toBe(200);
    responses.push({
      body: await response.json(),
      cache: response.headers()["x-vinext-cache"],
      cdnPolicy: response.headers()["cache-control"]?.includes("s-maxage") ?? false,
    });
  }

  expect(responses).toEqual(
    tenants.map((tenant) => ({
      body: { tenant: `${tenant}.localhost` },
      cache: undefined,
      cdnPolicy: false,
    })),
  );
});
