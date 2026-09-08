import {
  createWorkersResponseStoreClient,
  type ResponseStorePurgeOptions,
  type ResponseStoreRefreshOptions,
  type SerializableValue,
  type WorkersResponseStoreClientEnv,
  type WorkersResponseStore,
} from "@vinext/workers-response-store";

type RevalidatorOptions = {
  body?: string;
  cacheControl?: string;
  delayMs?: number;
};

const DEFAULT_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=60";

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function cacheRequest(request: Request, prefix: string): Request {
  const source = new URL(request.url);
  const pathname = source.pathname.slice(prefix.length) || "/";
  return new Request(`https://cache-key.invalid${pathname}${source.search}`);
}

async function put(request: Request, store: WorkersResponseStore): Promise<Response> {
  const headers = new Headers({
    "Cache-Control": request.headers.get("X-Response-Cache-Control") ?? DEFAULT_CACHE_CONTROL,
    "Content-Type": request.headers.get("Content-Type") ?? "application/octet-stream",
  });
  const tags = request.headers.get("X-Response-Cache-Tag");
  if (tags) headers.set("Cache-Tag", tags);

  const encodedArgs = request.headers.get("X-Revalidator-Args");
  const args = encodedArgs ? (JSON.parse(encodedArgs) as Record<string, SerializableValue>) : {};
  const result = await store.put(
    cacheRequest(request, "/admin/put"),
    new Response(request.body, { headers }),
    {
      revalidator: {
        id: "service-binding-example",
        args: [args],
      },
      purgeExisting: request.headers.get("X-Purge-Existing") === "1",
    },
  );

  return json(result);
}

const responseStore = createWorkersResponseStoreClient({
  async regenerate(input, { env }): Promise<Response> {
    const options = (input.args[0] ?? {}) as RevalidatorOptions;
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }

    return new Response(options.body ?? `regenerated:${crypto.randomUUID()}`, {
      headers: {
        "Cache-Control": options.cacheControl ?? DEFAULT_CACHE_CONTROL,
        "Content-Type": "text/plain; charset=utf-8",
        "X-Revalidation-Reason": input.reason,
        "X-Revalidation-Version": env.CF_VERSION_METADATA.id,
      },
    });
  },
});

export const { ResponseStoreRevalidator, ResponseStoreClient } = responseStore.entrypoints;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return json({
          name: "workers-response-store-service-client",
          status: "ready",
          deployment: "service-binding",
        });
      }

      if (request.method === "GET" && url.pathname.startsWith("/cache")) {
        return responseStore.fetch(cacheRequest(request, "/cache"));
      }

      if (request.method === "PUT" && url.pathname.startsWith("/admin/put")) {
        return put(request, responseStore);
      }

      if (request.method === "POST" && url.pathname === "/admin/refresh") {
        return json(
          await responseStore.refresh((await request.json()) as ResponseStoreRefreshOptions),
        );
      }

      if (request.method === "POST" && url.pathname === "/admin/purge") {
        return json(await responseStore.purge((await request.json()) as ResponseStorePurgeOptions));
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
} satisfies ExportedHandler<WorkersResponseStoreClientEnv>;
