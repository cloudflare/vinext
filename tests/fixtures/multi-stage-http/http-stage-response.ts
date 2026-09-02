import type { VinextRequestStageTransport } from "vinext/server/multi-stage";
import { loadVinextResponseStage } from "vinext/server/response-stage";
import {
  deserializeRequest,
  serializeRequest,
  startNodeFetchServer,
  type SerializedRequest,
} from "./http-stage-node";
import {
  getHostCacheEntry,
  setHostCacheEntry,
  type ResponseSnapshot,
} from "./http-stage-host-cache";

type StageEnvelope = {
  options: { cache: "shared" | "bypass" };
  props: unknown;
  request: SerializedRequest;
};

function internalStageHeaders(): Record<string, string> {
  const token = process.env.VINEXT_STAGE_TOKEN;
  if (!token) throw new Error("Missing VINEXT_STAGE_TOKEN");
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function isAuthorizedStageRequest(request: Request): boolean {
  const token = process.env.VINEXT_STAGE_TOKEN;
  return token !== undefined && request.headers.get("authorization") === `Bearer ${token}`;
}

const STREAM_DELAY_MS = 250;

function responseCacheKey(request: Request, props: unknown): string {
  return JSON.stringify([request.method, request.url, props]);
}

async function snapshotResponse(response: Response): Promise<ResponseSnapshot> {
  return {
    body: await response.arrayBuffer(),
    headers: [...response.headers],
    status: response.status,
    statusText: response.statusText,
  };
}

function responseFromSnapshot(snapshot: ResponseSnapshot): Response {
  return new Response(snapshot.body.slice(0), {
    headers: snapshot.headers,
    status: snapshot.status,
    statusText: snapshot.statusText,
  });
}

function withHostHeaders(response: Response, state: "BYPASS" | "HIT" | "MISS"): Response {
  const headers = new Headers(response.headers);
  headers.set("x-http-response-stage-pid", String(process.pid));
  headers.set("x-http-stage-cache", state);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function delayAfterFirstBytes(response: Response): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let delayedRemainder: Uint8Array | null = null;
  let splitFirstChunk = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (delayedRemainder) {
        await new Promise((resolve) => setTimeout(resolve, STREAM_DELAY_MS));
        controller.enqueue(delayedRemainder);
        delayedRemainder = null;
        return;
      }
      const next = await reader.read();
      if (next.done) {
        reader.releaseLock();
        controller.close();
        return;
      }
      if (!splitFirstChunk && next.value.byteLength > 1) {
        splitFirstChunk = true;
        const split = Math.max(1, Math.floor(next.value.byteLength / 2));
        delayedRemainder = next.value.slice(split);
        controller.enqueue(next.value.slice(0, split));
        return;
      }
      splitFirstChunk = true;
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
  const headers = new Headers(response.headers);
  headers.set("x-http-stage-stream-delay", String(STREAM_DELAY_MS));
  return new Response(stream, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function isSharedCacheable(response: Response): boolean {
  const policy =
    response.headers.get("cloudflare-cdn-cache-control") ??
    response.headers.get("cdn-cache-control") ??
    response.headers.get("cache-control");
  return (
    response.status >= 200 &&
    response.status < 400 &&
    policy !== null &&
    !/(?:^|,)\s*(?:no-store|no-cache|private)\b/i.test(policy)
  );
}

function withPrivateHostPolicy(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.delete("Cache-Tag");
  headers.delete("CDN-Cache-Control");
  headers.delete("Cloudflare-CDN-Cache-Control");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function responseCacheTags(response: Response): string[] {
  return (response.headers.get("cache-tag") ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

const responseStageFetch = async (transportRequest: Request): Promise<Response> => {
  if (new URL(transportRequest.url).pathname !== "/__vinext_response_stage") {
    return new Response("Not Found", { status: 404 });
  }
  if (!isAuthorizedStageRequest(transportRequest)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const envelope = (await transportRequest.json()) as StageEnvelope;
  const request = deserializeRequest(envelope.request);
  const cacheKey = responseCacheKey(request, envelope.props);

  if (envelope.options.cache === "shared") {
    const snapshot = await getHostCacheEntry(cacheKey);
    if (snapshot) return withHostHeaders(responseFromSnapshot(snapshot), "HIT");
  }

  const requestOrigin = process.env.VINEXT_REQUEST_STAGE_ORIGIN;
  if (!requestOrigin) return new Response("Missing request-stage origin", { status: 500 });
  const dispatchRequestStage: VinextRequestStageTransport = async (stageRequest) =>
    fetch(new URL("/__vinext_request_stage", requestOrigin), {
      body: JSON.stringify({ request: await serializeRequest(stageRequest) }),
      headers: internalStageHeaders(),
      method: "POST",
    });
  const { handleResponseStage } = await loadVinextResponseStage();
  const rendered = await handleResponseStage(
    request,
    {},
    { hostRuntime: "node" },
    envelope.props,
    dispatchRequestStage,
    envelope.options,
  );
  if (envelope.options.cache === "bypass" || !isSharedCacheable(rendered)) {
    return withHostHeaders(rendered, "BYPASS");
  }
  // A cache hit never needs response admission. Keep even this lightweight
  // framework policy behind the miss path so the host entry remains a lazy
  // proxy until it actually renders a response.
  const { hasUnsupportedResponseStageVary } = await import("vinext/server/multi-stage");
  if (hasUnsupportedResponseStageVary(rendered.headers)) {
    return withHostHeaders(withPrivateHostPolicy(rendered), "BYPASS");
  }

  if (!rendered.body) {
    setHostCacheEntry(
      cacheKey,
      Promise.resolve(await snapshotResponse(rendered.clone())),
      responseCacheTags(rendered),
    );
    return withHostHeaders(rendered, "MISS");
  }
  const [foregroundBody, cacheBody] = rendered.body.tee();
  const foreground = delayAfterFirstBytes(new Response(foregroundBody, rendered));
  setHostCacheEntry(
    cacheKey,
    snapshotResponse(new Response(cacheBody, rendered)).catch(() => null),
    responseCacheTags(rendered),
  );
  return withHostHeaders(foreground, "MISS");
};

export default { fetch: responseStageFetch };

startNodeFetchServer(responseStageFetch);
