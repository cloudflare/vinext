import { test, expect } from "@playwright/test";

const PURGE_BEARER = "e2e-purge-token";

test.describe("service routes", () => {
  test("status reports the instrumentation boot hook", async ({ request }) => {
    const response = await request.get("/api/status");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("up");
    expect(body.bootHookRan).toBe(true);
  });

  test.fixme("purge requires the bearer token", async ({ request }) => {
    const unauthorised = await request.post("/api/purge", {
      data: { registry: "chrome-nav", op: "nav-tree" },
    });
    expect(unauthorised.status()).toBe(401);
  });

  test.fixme("purge validates its payload and evicts by prefix", async ({ request }) => {
    const badPayload = await request.post("/api/purge", {
      headers: { authorization: PURGE_BEARER },
      data: { registry: "" },
    });
    expect(badPayload.status()).toBe(400);

    const unknownRegistry = await request.post("/api/purge", {
      headers: { authorization: PURGE_BEARER },
      data: { registry: "not-a-registry", op: "nav-tree" },
    });
    expect(unknownRegistry.status()).toBe(404);

    // Warm the CA-zone nav memo, purge exactly that key (keyHint scopes the
    // eviction so the fallback zone's memo — asserted elsewhere — survives),
    // and confirm a fresh minted-at appears.
    const mintedAt = async (): Promise<string | undefined> => {
      const html = await (await request.get("/ca/journal")).text();
      return html.match(/data-nav-minted-at="(\d+)"/)?.[1];
    };
    // On a cold cache, parallel workers can race the first mint (both miss,
    // both store), so poll until two consecutive samples agree before
    // relying on the memoised value.
    let before = await mintedAt();
    await expect
      .poll(
        async () => {
          const again = await mintedAt();
          const settled = again === before;
          before = again;
          return settled;
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    const purge = await request.post("/api/purge", {
      headers: { authorization: PURGE_BEARER },
      data: { registry: "chrome-nav", op: "nav-tree", keyHint: "Z2" },
    });
    expect(purge.status()).toBe(200);

    const after = await mintedAt();
    expect(after).not.toBe(before);
  });

  test("menu endpoint resolves zone from its query", async ({ request }) => {
    const response = await request.get("/api/menu?zone=ca");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.zone).toBe("ca");
    expect(body.branches.length).toBeGreaterThan(0);
  });

  test("graph endpoint executes ops for the browser client", async ({ request }) => {
    const response = await request.post("/api/graph", {
      data: { op: "lookupAssets", variables: { term: "fern" } },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.term).toBe("fern");

    const unknown = await request.post("/api/graph", {
      data: { op: "notAnOp" },
    });
    expect(unknown.status()).toBe(400);
  });

  test("trials manifest requires a key", async ({ request }) => {
    expect((await request.get("/api/trials-manifest")).status()).toBe(400);
    const keyed = await request.get("/api/trials-manifest?key=abc");
    expect(keyed.status()).toBe(200);
    const body = await keyed.json();
    expect(body.launch_timer.enabled).toBe(true);
  });
});
