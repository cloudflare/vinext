import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type SerializedRequest = {
  body: string | null;
  headers: Array<[string, string]>;
  method: string;
  url: string;
};

async function readIncomingBody(request: IncomingMessage): Promise<Uint8Array | null> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }
  if (chunks.length === 0) return null;
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function incomingHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

export async function incomingMessageToRequest(request: IncomingMessage): Promise<Request> {
  const host = request.headers.host ?? "127.0.0.1";
  const body = await readIncomingBody(request);
  return new Request(new URL(request.url ?? "/", `http://${host}`), {
    body,
    headers: incomingHeaders(request),
    method: request.method ?? "GET",
  });
}

export async function serializeRequest(request: Request): Promise<SerializedRequest> {
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : Buffer.from(await request.arrayBuffer()).toString("base64");
  return {
    body,
    headers: [...request.headers],
    method: request.method,
    url: request.url,
  };
}

export function deserializeRequest(request: SerializedRequest): Request {
  return new Request(request.url, {
    body: request.body === null ? null : Buffer.from(request.body, "base64"),
    headers: request.headers,
    method: request.method,
  });
}

export async function writeNodeResponse(
  response: Response,
  nodeResponse: ServerResponse,
): Promise<void> {
  nodeResponse.statusCode = response.status;
  nodeResponse.statusMessage = response.statusText;
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") nodeResponse.setHeader(name, value);
  }
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) nodeResponse.setHeader("set-cookie", setCookies);
  nodeResponse.flushHeaders();
  if (!response.body) {
    nodeResponse.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!nodeResponse.write(value)) {
        await new Promise<void>((resolve) => nodeResponse.once("drain", resolve));
      }
    }
    nodeResponse.end();
  } catch (error) {
    nodeResponse.destroy(error instanceof Error ? error : new Error(String(error)));
  }
}

export function startNodeFetchServer(fetchHandler: (request: Request) => Promise<Response>): void {
  const port = Number(process.env.PORT ?? "0");
  const server = createServer(async (request, response) => {
    try {
      await writeNodeResponse(
        await fetchHandler(await incomingMessageToRequest(request)),
        response,
      );
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP stage address");
    console.log(`VINEXT_HTTP_STAGE_READY:${address.port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
