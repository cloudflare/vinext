import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";

const base =
  process.env.LIVE_CACHE_BASE ?? "https://vinext-programmatic-cache-poc-user.vinext.workers.dev";

function key(label) {
  return `live-${label}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

async function put(path, body, options = {}) {
  const headers = new Headers({
    "Content-Type": options.contentType ?? "text/plain; charset=utf-8",
    "X-Response-Cache-Control": options.cacheControl ?? "public, max-age=120",
  });
  if (options.host) headers.set("X-Cache-Host", options.host);
  if (options.tags) headers.set("X-Response-Cache-Tag", options.tags.join(","));
  if (options.revalidator) headers.set("X-Revalidator-Args", JSON.stringify(options.revalidator));
  if (options.purgeExisting) headers.set("X-Purge-Existing", "1");
  const response = await fetch(`${base}/admin/put${path}`, {
    method: "PUT",
    headers,
    body,
  });
  if (response.status !== 200)
    assert.fail(`put returned ${response.status}: ${await response.text()}`);
  return response.json();
}

function read(path, options = {}) {
  const headers = options.host ? { "X-Cache-Host": options.host } : undefined;
  return fetch(`${base}/cache${path}`, { headers });
}

async function refreshSelectors(options) {
  return fetch(`${base}/admin/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
}

async function purge(options) {
  const response = await fetch(`${base}/admin/purge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (response.status !== 200)
    assert.fail(`purge returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function eventually(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last.ok) return last.value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(last?.message ?? "condition did not become true");
}

test("live Workers Cache MISS then HIT bypasses the binding Worker and excludes host from identity", async () => {
  const id = key("hit");
  await put(`/${id}?variant=1`, "live-seed", { host: "one.example" });

  const miss = await read(`/${id}?variant=1`, { host: "one.example" });
  const missBody = await miss.text();
  const hit = await read(`/${id}?variant=1`, { host: "two.example" });
  const hitBody = await hit.text();

  assert.equal(missBody, "live-seed");
  assert.equal(hitBody, "live-seed");
  assert.equal(miss.headers.get("CF-Cache-Status"), "MISS");
  assert.equal(hit.headers.get("CF-Cache-Status"), "HIT");
  assert.equal(
    hit.headers.get("X-Workers-Response-Store-Binding-Invocation"),
    miss.headers.get("X-Workers-Response-Store-Binding-Invocation"),
  );
});

test("live put updates R2 before purging an existing edge response", async () => {
  const id = key("refill");
  await put(`/${id}`, "old-body");
  assert.equal(await (await read(`/${id}`)).text(), "old-body");

  const mutation = await put(`/${id}`, "new-body", { purgeExisting: true });
  assert.deepEqual(mutation, { backingStoreUpdated: true, edgePurgeAccepted: true });
  const refill = await eventually(async () => {
    const response = await read(`/${id}`);
    const body = await response.text();
    return body === "new-body"
      ? { ok: true, value: response }
      : { ok: false, message: `edge still returned ${JSON.stringify(body)}` };
  });
  assert.equal(refill.headers.get("X-Workers-Response-Store-Revision"), "2");
});

test("live manual refresh calls the named user entrypoint and exposes only the committed revision", async () => {
  const id = key("refresh");
  const tag = `manual-${id}`;
  await put(`/${id}`, "old-body", {
    tags: [tag],
    revalidator: { bodyPrefix: "live-refreshed", cacheControl: "public, max-age=120" },
  });
  await (await read(`/${id}`)).arrayBuffer();

  const refreshResponse = await refreshSelectors({ tags: [tag] });
  if (refreshResponse.status !== 200) {
    assert.fail(`refresh returned ${refreshResponse.status}: ${await refreshResponse.text()}`);
  }
  assert.deepEqual(await refreshResponse.json(), {
    backingStoreUpdated: true,
    edgePurgeAccepted: true,
  });
  const response = await eventually(async () => {
    const candidate = await read(`/${id}`);
    const body = await candidate.clone().text();
    return body.startsWith("live-refreshed:")
      ? { ok: true, value: candidate }
      : { ok: false, message: `refresh returned ${JSON.stringify(body)}` };
  });
  assert.equal(response.headers.get("X-Workers-Response-Store-Revision"), "2");
  assert.equal(response.headers.get("X-Revalidation-Reason"), "manual");
  assert.match(response.headers.get("X-Revalidation-Version"), /^[\da-f-]{36}$/);
});

test("live refresh selects and regenerates entries by tag and path prefix", async () => {
  const id = key("refresh-selectors");
  const tag = `refresh-${id}`;
  await put(`/${id}/tagged`, "tagged-seed", {
    tags: [tag],
    revalidator: {
      body: "tag-refreshed",
      cacheControl: "public, max-age=120",
      cacheTags: [tag],
    },
  });
  await put(`/${id}/prefix/a`, "prefix-seed", {
    revalidator: { body: "prefix-refreshed", cacheControl: "public, max-age=120" },
  });
  await Promise.all([
    read(`/${id}/tagged`).then((response) => response.arrayBuffer()),
    read(`/${id}/prefix/a`).then((response) => response.arrayBuffer()),
  ]);

  const tagRefresh = await refreshSelectors({ tags: [tag.toUpperCase()] });
  if (tagRefresh.status !== 200) {
    assert.fail(`tag refresh returned ${tagRefresh.status}: ${await tagRefresh.text()}`);
  }
  assert.deepEqual(await tagRefresh.json(), {
    backingStoreUpdated: true,
    edgePurgeAccepted: true,
  });
  await eventually(async () => {
    const response = await read(`/${id}/tagged`);
    const body = await response.text();
    return body === "tag-refreshed"
      ? { ok: true, value: response }
      : { ok: false, message: `tag refresh returned ${JSON.stringify(body)}` };
  });

  const prefixRefresh = await refreshSelectors({ pathPrefixes: [`/${id}/prefix`] });
  if (prefixRefresh.status !== 200) {
    assert.fail(`prefix refresh returned ${prefixRefresh.status}: ${await prefixRefresh.text()}`);
  }
  assert.deepEqual(await prefixRefresh.json(), {
    backingStoreUpdated: true,
    edgePurgeAccepted: true,
  });
  await eventually(async () => {
    const response = await read(`/${id}/prefix/a`);
    const body = await response.text();
    return body === "prefix-refreshed"
      ? { ok: true, value: response }
      : { ok: false, message: `prefix refresh returned ${JSON.stringify(body)}` };
  });
});

test("live hard expiry never serves the expired R2 body", async () => {
  const id = key("expired");
  await put(`/${id}`, "forbidden-expired-body", {
    cacheControl: "public, max-age=0",
    revalidator: { body: "hard-expiry-regenerated", cacheControl: "public, max-age=120" },
  });

  const response = await read(`/${id}`);
  assert.equal(await response.text(), "hard-expiry-regenerated");
  assert.equal(response.headers.get("X-Revalidation-Reason"), "expired");
  assert.equal(response.headers.get("X-Workers-Response-Store-Revision"), "2");
});

test("live purge applies tag, path-prefix, and purge-everything selectors", async () => {
  const id = key("purge");
  const tag = `tag-${id}`;
  // Purge acceptance and propagation are separate. Keep these edge entries
  // short-lived so the test can always observe the durable tombstone even if
  // global purge propagation is delayed during repeated canary runs.
  const purgePolicy = "public, max-age=2";
  await put(`/${id}/tagged`, "tagged", { tags: [tag], cacheControl: purgePolicy });
  await put(`/${id}/prefix/a`, "prefix", {
    tags: ["unrelated"],
    cacheControl: purgePolicy,
  });
  await put(`/${id}/keep`, "keep", { cacheControl: "public, max-age=120" });
  await Promise.all([
    read(`/${id}/tagged`).then((response) => response.arrayBuffer()),
    read(`/${id}/prefix/a`).then((response) => response.arrayBuffer()),
    read(`/${id}/keep`).then((response) => response.arrayBuffer()),
  ]);

  assert.deepEqual(await purge({ tags: [tag] }), {
    backingStoreUpdated: true,
    edgePurgeAccepted: true,
  });
  await eventually(async () => {
    const response = await read(`/${id}/tagged`);
    return response.status === 404
      ? { ok: true, value: response }
      : { ok: false, message: `tagged entry still returned ${response.status}` };
  });

  await purge({ pathPrefixes: [`/${id}/prefix`] });
  await eventually(async () => {
    const response = await read(`/${id}/prefix/a`);
    return response.status === 404
      ? { ok: true, value: response }
      : { ok: false, message: `prefix entry still returned ${response.status}` };
  });
  assert.equal(await (await read(`/${id}/keep`)).text(), "keep");

  assert.deepEqual(await purge({ purgeEverything: true }), {
    backingStoreUpdated: true,
    edgePurgeAccepted: true,
  });
});

test("live loopback failure preserves the last usable R2 and edge response", async () => {
  const id = key("failure");
  const tag = `failure-${id}`;
  await put(`/${id}`, "surviving-body", { tags: [tag], revalidator: { fail: true } });
  await (await read(`/${id}`)).arrayBuffer();

  const failedRefresh = await refreshSelectors({ tags: [tag] });
  assert.equal(failedRefresh.status, 500);
  await failedRefresh.arrayBuffer();
  const stillActive = await read(`/${id}`);
  assert.equal(await stillActive.text(), "surviving-body");
});

test("live R2 path stores and refills a 10 MiB body", async () => {
  const id = key("large");
  const size = 10 * 1024 * 1024;
  const body = new Uint8Array(size);
  body.fill(97);
  const mutation = await put(`/${id}`, body, { contentType: "application/octet-stream" });
  assert.equal(mutation.backingStoreUpdated, true);

  const response = await read(`/${id}`);
  const returned = new Uint8Array(await response.arrayBuffer());
  assert.equal(returned.byteLength, size);
  assert.equal(returned[0], 97);
  assert.equal(returned.at(-1), 97);
});

test("live SWR serves stale immediately, regenerates once, and promotes fresh R2 on a later callback", async () => {
  const id = key("swr");
  await put(`/${id}`, "swr-seed", {
    cacheControl: "public, max-age=1, stale-while-revalidate=20",
    revalidator: {
      body: "swr-regenerated",
      cacheControl: "public, max-age=120",
      delayMs: 1_000,
    },
  });
  const initial = await read(`/${id}`);
  await initial.arrayBuffer();
  await new Promise((resolve) => setTimeout(resolve, 1800));

  const startedAt = Date.now();
  const stale = await read(`/${id}`);
  assert.equal(await stale.text(), "swr-seed");
  assert.equal(stale.headers.get("CF-Cache-Status"), "UPDATING");
  assert.ok(Date.now() - startedAt < 700, "the stale response should not await regeneration");

  const fresh = await eventually(async () => {
    const response = await read(`/${id}`);
    const body = await response.clone().text();
    return body === "swr-regenerated"
      ? { ok: true, value: response }
      : { ok: false, message: `SWR still returned ${JSON.stringify(body)}` };
  });
  assert.equal(fresh.headers.get("X-Workers-Response-Store-Revision"), "2");
  assert.equal(fresh.headers.get("X-Revalidation-Reason"), "swr");
});
