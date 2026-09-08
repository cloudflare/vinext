import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";

const base =
  process.env.LIVE_RESPONSE_STORE_SERVICE_BASE ??
  "https://vinext-workers-response-store-service-client-poc.vinext.workers.dev";

function key(label) {
  return `service-${label}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

async function put(path, body, options = {}) {
  const response = await fetch(`${base}/admin/put${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Response-Cache-Control": options.cacheControl ?? "public, max-age=120",
      "X-Revalidator-Args": JSON.stringify({
        body: options.regeneratedBody ?? "regenerated",
        cacheControl: "public, max-age=120",
        delayMs: options.delayMs,
      }),
    },
    body,
  });
  assert.equal(response.status, 200, await response.text());
}

function read(path) {
  return fetch(`${base}/cache${path}`);
}

async function eventually(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "condition not checked";

  while (Date.now() < deadline) {
    const result = await check();
    if (result.ok) return result.value;
    last = result.message;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  assert.fail(last);
}

test("the service-bound callback has a stable Workers Cache identity", async () => {
  const path = `/${key("identity")}`;
  await put(path, "stored");

  const miss = await read(path);
  assert.equal(await miss.text(), "stored");
  assert.equal(miss.headers.get("CF-Cache-Status"), "MISS");

  const hit = await read(path);
  assert.equal(await hit.text(), "stored");
  assert.equal(hit.headers.get("CF-Cache-Status"), "HIT");
  assert.equal(
    hit.headers.get("X-Workers-Response-Store-Binding-Invocation"),
    miss.headers.get("X-Workers-Response-Store-Binding-Invocation"),
  );
});

test("manual refresh loops back into the user Worker without a reverse binding", async () => {
  const path = `/${key("refresh")}`;
  await put(path, "seed", { regeneratedBody: "refreshed" });
  await (await read(path)).arrayBuffer();

  const refresh = await fetch(`${base}/admin/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pathPrefixes: [path] }),
  });
  assert.equal(refresh.status, 200);
  assert.deepEqual(await refresh.json(), {
    backingStoreUpdated: true,
    edgePurgeAccepted: true,
  });

  const response = await read(path);
  assert.equal(await response.text(), "refreshed");
  assert.equal(response.headers.get("X-Revalidation-Reason"), "manual");
  assert.notEqual(response.headers.get("X-Revalidation-Version"), null);
});

test("service-bound SWR returns stale before its loopback regeneration finishes", async () => {
  const path = `/${key("swr")}`;
  await put(path, "stale", {
    cacheControl: "public, max-age=1, stale-while-revalidate=20",
    regeneratedBody: "fresh",
    delayMs: 1_000,
  });
  await (await read(path)).arrayBuffer();
  await new Promise((resolve) => setTimeout(resolve, 1_800));

  const startedAt = Date.now();
  const stale = await read(path);
  assert.equal(await stale.text(), "stale");
  assert.equal(stale.headers.get("CF-Cache-Status"), "UPDATING");
  assert.ok(Date.now() - startedAt < 700, "the stale response should not await regeneration");

  const fresh = await eventually(async () => {
    const response = await read(path);
    const body = await response.clone().text();
    return body === "fresh"
      ? { ok: true, value: response }
      : { ok: false, message: `SWR still returned ${JSON.stringify(body)}` };
  });
  assert.equal(fresh.headers.get("X-Revalidation-Reason"), "swr");
  assert.notEqual(fresh.headers.get("X-Revalidation-Version"), null);
});
