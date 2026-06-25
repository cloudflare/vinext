/** Cloudflare Worker entry point for web-specific APIs and scheduled maintenance. */
import handler from "vinext/server/app-router-entry";

type Env = {
  ASSETS: Fetcher;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
  DB: D1Database;
  VINEXT_KV_CACHE: KVNamespace;
  PERFORMANCE_PROFILES: R2Bucket;
  COMPAT_INGEST_SECRET?: string;
};

type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};

async function sweepPerformanceProfiles(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(`
    SELECT object_key
    FROM performance_profile_objects
    WHERE NOT EXISTS (
      SELECT 1
      FROM performance_measurements
      WHERE profile_object_key = performance_profile_objects.object_key
    )
      AND created_at <= datetime('now', '-1 day')
    ORDER BY created_at
    LIMIT 100
  `).all<{ object_key: string }>();
  for (const { object_key: key } of results) {
    let deleted;
    try {
      deleted = await env.DB.prepare(
        "DELETE FROM performance_profile_objects WHERE object_key = ? RETURNING object_key",
      )
        .bind(key)
        .first<{ object_key: string }>();
    } catch (error) {
      console.error("Failed to claim performance profile for sweeping", key, error);
      continue;
    }
    if (!deleted) continue;
    try {
      await env.PERFORMANCE_PROFILES.delete(key);
    } catch (error) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO performance_profile_objects (object_key) VALUES (?)",
      )
        .bind(key)
        .run();
      console.error("Failed to sweep performance profile", key, error);
    }
  }
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index++) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function uploadPerformanceProfile(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("x-compat-secret") ?? "";
  if (
    !env.COMPAT_INGEST_SECRET ||
    !secret ||
    !(await safeEqual(secret, env.COMPAT_INGEST_SECRET))
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  const runKind = request.headers.get("x-performance-run-kind");
  const commitSha = request.headers.get("x-performance-commit-sha");
  const executionId = request.headers.get("x-performance-execution-id");
  const benchmarkId = request.headers.get("x-performance-benchmark-id");
  if (
    (runKind !== "main" && runKind !== "pull_request") ||
    !commitSha?.match(/^[0-9a-f]{40}$/i) ||
    !executionId ||
    !benchmarkId ||
    !request.body
  ) {
    return new Response("Invalid performance profile metadata", { status: 400 });
  }
  const key = `profiles/${runKind}/${commitSha.toLowerCase()}/${encodeURIComponent(executionId)}/${crypto.randomUUID()}/${encodeURIComponent(benchmarkId)}.json.gz`;
  await env.PERFORMANCE_PROFILES.put(key, request.body, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { benchmarkId, commitSha: commitSha.toLowerCase(), runKind },
  });
  try {
    await env.DB.prepare("INSERT INTO performance_profile_objects (object_key) VALUES (?)")
      .bind(key)
      .run();
  } catch (error) {
    await env.PERFORMANCE_PROFILES.delete(key);
    throw error;
  }
  return Response.json({ key }, { status: 201 });
}

async function deletePerformanceProfile(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("x-compat-secret") ?? "";
  if (
    !env.COMPAT_INGEST_SECRET ||
    !secret ||
    !(await safeEqual(secret, env.COMPAT_INGEST_SECRET))
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  const key = request.headers.get("x-performance-profile-key");
  if (!key?.match(/^profiles\/(?:main|pull_request)\/[0-9a-f]{40}\//i)) {
    return new Response("Invalid performance profile key", { status: 400 });
  }
  const deleted = await env.DB.prepare(
    "DELETE FROM performance_profile_objects WHERE object_key = ? RETURNING object_key",
  )
    .bind(key)
    .first<{ object_key: string }>();
  if (!deleted) {
    return new Response("Performance profile is referenced by a committed run", { status: 409 });
  }
  try {
    await env.PERFORMANCE_PROFILES.delete(key);
  } catch (error) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO performance_profile_objects (object_key) VALUES (?)",
    )
      .bind(key)
      .run();
    throw error;
  }
  return new Response(null, { status: 204 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "PUT" && url.pathname === "/api/benchmarks/profile-upload") {
      return uploadPerformanceProfile(request, env);
    }
    if (request.method === "DELETE" && url.pathname === "/api/benchmarks/profile-upload") {
      return deletePerformanceProfile(request, env);
    }

    // Delegate everything else to vinext, forwarding ctx so that
    // ctx.waitUntil() is available to background cache writes and
    // other deferred work via getRequestExecutionContext().
    return handler.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sweepPerformanceProfiles(env));
  },
};
