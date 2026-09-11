import {
  createWorkersResponseStore,
  type ResponseStorePurgeOptions,
  type ResponseStoreRefreshOptions,
  type SerializableValue,
  type WorkersResponseStoreEnv,
  type WorkersResponseStore,
} from "@vinext/workers-response-store";

type FixtureRevalidatorOptions = {
  body?: string;
  bodyPrefix?: string;
  cacheControl?: string;
  cacheTags?: string[];
  delayMs?: number;
  fail?: boolean;
  failOnce?: boolean;
};

const DEFAULT_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=60";
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// Fixture-only state used by E2E assertions.
let regenerationCount = 0;
const failedOnce = new Set<string>();

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function cacheRequest(request: Request, prefix: string): Request {
  const source = new URL(request.url);
  const pathname = source.pathname.slice(prefix.length) || "/";
  const host = request.headers.get("X-Cache-Host") ?? "cache-key.invalid";

  return new Request(`https://${host}${pathname}${source.search}`, { method: "GET" });
}

async function handlePut(request: Request, store: WorkersResponseStore): Promise<Response> {
  const target = cacheRequest(request, "/admin/put");
  const status = Number.parseInt(request.headers.get("X-Response-Status") ?? "200", 10);
  const bodyDelayMs = Number.parseInt(request.headers.get("X-Body-Delay-Ms") ?? "0", 10);

  const headers = new Headers({
    "Cache-Control": request.headers.get("X-Response-Cache-Control") ?? DEFAULT_CACHE_CONTROL,
    "Content-Type": request.headers.get("Content-Type") ?? "application/octet-stream",
  });

  const cacheTags = request.headers.get("X-Response-Cache-Tag");
  const age = request.headers.get("X-Response-Age");
  const cloudflareCacheControl = request.headers.get("X-Response-Cloudflare-CDN-Cache-Control");
  const cdnCacheControl = request.headers.get("X-Response-CDN-Cache-Control");

  if (cacheTags) headers.set("Cache-Tag", cacheTags);
  if (age) headers.set("Age", age);
  if (cloudflareCacheControl) {
    headers.set("Cloudflare-CDN-Cache-Control", cloudflareCacheControl);
  }
  if (cdnCacheControl) headers.set("CDN-Cache-Control", cdnCacheControl);

  let body = request.body;
  if (request.headers.get("X-Body-Failure") === "1") {
    body = new ReadableStream({
      start(controller) {
        controller.error(new Error("Fixture body failure"));
      },
    });
  }
  if (body && bodyDelayMs > 0) {
    const reader = body.getReader();
    let delayed = false;

    body = new ReadableStream({
      async pull(controller) {
        if (!delayed) {
          delayed = true;
          await new Promise((resolve) => setTimeout(resolve, bodyDelayMs));
        }

        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }

  const response = new Response(NULL_BODY_STATUSES.has(status) ? null : body, {
    status,
    headers,
  });

  const encodedArgs = request.headers.get("X-Revalidator-Args");
  const args = encodedArgs ? (JSON.parse(encodedArgs) as Record<string, SerializableValue>) : {};
  const revalidator =
    request.headers.get("X-No-Revalidator") === "1"
      ? undefined
      : {
          id: request.headers.get("X-Revalidator-Id") ?? "fixture-render",
          args: [args],
        };

  const result = await store.put(target, response, {
    coalesce: request.headers.get("X-Coalesce") === "1",
    revalidator,
    purgeExisting: request.headers.get("X-Purge-Existing") === "1",
  });

  return json(result);
}

const responseStore = createWorkersResponseStore({
  async regenerate(input, { env, ctx }): Promise<Response> {
    if (typeof Reflect.get(ctx.exports, "ResponseStoreBinding") !== "function") {
      throw new Error("ResponseStoreBinding is missing from the revalidation context");
    }

    regenerationCount += 1;

    const options = (input.args[0] ?? {}) as FixtureRevalidatorOptions;
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    if (options.fail) {
      throw new Error("Fixture regeneration failure");
    }

    const requestUrl = new URL(input.request.url);
    const cacheKey = requestUrl.pathname + requestUrl.search;

    if (options.failOnce && !failedOnce.has(cacheKey)) {
      failedOnce.add(cacheKey);
      throw new Error("Fixture one-time regeneration failure");
    }

    const body =
      options.body ??
      `${options.bodyPrefix ?? "regenerated"}:${regenerationCount}:${crypto.randomUUID()}`;
    const headers = new Headers({
      "Cache-Control": options.cacheControl ?? DEFAULT_CACHE_CONTROL,
      "Content-Type": "text/plain; charset=utf-8",
      "X-Revalidation-Id": input.id,
      "X-Revalidation-Reason": input.reason,
      "X-Revalidation-Request": cacheKey,
      "X-Revalidation-Observed-Visitor": input.request.headers.get("X-Visitor-Secret") ?? "absent",
      "X-Revalidation-Version": env.CF_VERSION_METADATA?.id ?? "missing",
    });

    if (options.cacheTags?.length) {
      headers.set("Cache-Tag", options.cacheTags.join(","));
    }

    return new Response(body, { headers });
  },
});

export const { CacheMetadata, ResponseStoreRevalidator, ResponseStoreBinding } =
  responseStore.entrypoints;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return json({
          name: "workers-response-store-poc",
          status: "ready",
          backing: ["Workers Cache", "R2", "SQLite Durable Object"],
          api: ["fetch", "put", "refresh", "purge"],
          deployment: "single-worker",
          revalidator: "ResponseStoreRevalidator.regenerate",
        });
      }

      if (request.method === "GET" && url.pathname.startsWith("/cache")) {
        return responseStore.fetch(cacheRequest(request, "/cache"));
      }

      if (request.method === "PUT" && url.pathname.startsWith("/admin/put")) {
        return handlePut(request, responseStore);
      }

      if (request.method === "POST" && url.pathname === "/admin/refresh") {
        const options = (await request.json()) as ResponseStoreRefreshOptions;
        return json(await responseStore.refresh(options));
      }

      if (request.method === "POST" && url.pathname === "/admin/purge") {
        const options = (await request.json()) as ResponseStorePurgeOptions;
        return json(await responseStore.purge(options));
      }

      if (request.method === "POST" && url.pathname === "/admin/tag-expiration") {
        const { newerThan, tags } = (await request.json()) as {
          newerThan?: number;
          tags: string[];
        };
        return json({ expiration: await responseStore.getTagExpiration(tags, newerThan) });
      }

      if (request.method === "GET" && url.pathname === "/admin/stats") {
        return json({ regenerationCount });
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
} satisfies ExportedHandler<WorkersResponseStoreEnv>;
