import http from "node:http";
import { gunzipSync } from "node:zlib";
import { parseEnvelope } from "@sentry/core";

const transactions = [];
const errors = [];
const items = [];
const decoder = new TextDecoder();

function getNanosecondTimestamp() {
  const [seconds, nanoseconds] = process.hrtime();
  return seconds * 1e9 + nanoseconds;
}

function decodePayload(payload) {
  if (!(payload instanceof Uint8Array)) return payload;
  try {
    return JSON.parse(decoder.decode(payload));
  } catch {
    return payload;
  }
}

function readEnvelopeItems(envelope) {
  const [, items] = parseEnvelope(envelope);
  return items.map(([header, payload]) => ({
    header,
    body: decodePayload(payload),
  }));
}

http
  .createServer((request, response) => {
    if (
      request.method === "GET" &&
      (request.url?.startsWith("/transactions") ||
        request.url?.startsWith("/errors") ||
        request.url?.startsWith("/items"))
    ) {
      const after = Number(new URL(request.url, "http://localhost").searchParams.get("after"));
      const storedEvents = request.url.startsWith("/transactions")
        ? transactions
        : request.url.startsWith("/errors")
          ? errors
          : items;
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(storedEvents.filter(({ receivedAt }) => receivedAt >= after)));
      return;
    }

    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const envelope = request.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body;
      const receivedAt = getNanosecondTimestamp();
      for (const item of readEnvelopeItems(envelope)) {
        items.push({ ...item, receivedAt });
        const destination = item.header.type === "transaction" ? transactions : errors;
        if (item.header.type === "transaction" || item.header.type === "event") {
          destination.push({ event: item.body, receivedAt });
        }
        destination.splice(0, Math.max(0, destination.length - 100));
      }
      items.splice(0, Math.max(0, items.length - 500));
      response.writeHead(200, { "access-control-allow-origin": "*" }).end("{}");
    });
  })
  .listen(3031);
