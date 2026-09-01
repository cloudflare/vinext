import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VinextResponseStageTransport } from "vinext/server/multi-stage";
import { loadVinextRequestStage } from "vinext/server/request-stage";
import {
  deserializeRequest,
  serializeRequest,
  startNodeFetchServer,
  type SerializedRequest,
} from "./http-stage-node";

type RequestStageEnvelope = { request: SerializedRequest };

function internalStageHeaders(): Record<string, string> {
  const token = process.env.VINEXT_STAGE_TOKEN;
  if (!token) throw new Error("Missing VINEXT_STAGE_TOKEN");
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function isAuthorizedStageRequest(request: Request): boolean {
  const token = process.env.VINEXT_STAGE_TOKEN;
  return token !== undefined && request.headers.get("authorization") === `Bearer ${token}`;
}

const assets = {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/stage-asset.txt") {
      return new Response("Not Found", { status: 404 });
    }
    const body = await readFile(path.join(process.cwd(), "public/stage-asset.txt"));
    return new Response(request.method === "HEAD" ? null : body, {
      headers: {
        "content-length": String(body.byteLength),
        "content-type": "text/plain; charset=utf-8",
      },
    });
  },
};

const gatewayFetch = async (transportRequest: Request): Promise<Response> => {
  const isInternalPath = new URL(transportRequest.url).pathname === "/__vinext_request_stage";
  if (isInternalPath && !isAuthorizedStageRequest(transportRequest)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const isInternalDispatch = transportRequest.method === "POST" && isInternalPath;
  const request = isInternalDispatch
    ? deserializeRequest(((await transportRequest.json()) as RequestStageEnvelope).request)
    : transportRequest;
  const responseOrigin = process.env.VINEXT_RESPONSE_STAGE_ORIGIN;
  if (!responseOrigin) return new Response("Missing response-stage origin", { status: 500 });

  const dispatchResponseStage: VinextResponseStageTransport = async (
    stageRequest,
    props,
    options,
  ) => {
    const response = await fetch(new URL("/__vinext_response_stage", responseOrigin), {
      body: JSON.stringify({
        options,
        props,
        request: await serializeRequest(stageRequest),
      }),
      headers: internalStageHeaders(),
      method: "POST",
    });
    return response;
  };

  const { handleRequestStage } = await loadVinextRequestStage();
  const response = await handleRequestStage(
    request,
    {},
    { assets, hostRuntime: "node" },
    dispatchResponseStage,
  );
  const headers = new Headers(response.headers);
  headers.set("x-http-request-stage-pid", String(process.pid));
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

export default { fetch: gatewayFetch };

startNodeFetchServer(gatewayFetch);
