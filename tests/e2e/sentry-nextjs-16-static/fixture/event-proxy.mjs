import http from "node:http";
import { gunzipSync } from "node:zlib";

const transactions = [];
const errors = [];

function readEnvelopeItems(envelope) {
  let cursor = envelope.indexOf("\n") + 1;
  const events = [];

  while (cursor > 0 && cursor < envelope.length) {
    const headerEnd = envelope.indexOf("\n", cursor);
    if (headerEnd === -1) break;

    const header = JSON.parse(envelope.slice(cursor, headerEnd));
    cursor = headerEnd + 1;

    const payloadLineEnd = envelope.indexOf("\n", cursor);
    const payloadEnd =
      typeof header.length === "number"
        ? cursor + header.length
        : payloadLineEnd === -1
          ? envelope.length
          : payloadLineEnd;
    if (payloadEnd < cursor) break;

    if (header.type === "transaction" || header.type === "event") {
      events.push({
        type: header.type,
        event: JSON.parse(envelope.slice(cursor, payloadEnd)),
      });
    }

    cursor = payloadEnd + (envelope[payloadEnd] === "\n" ? 1 : 0);
  }

  return events;
}

http
  .createServer((request, response) => {
    if (
      request.method === "GET" &&
      (request.url?.startsWith("/transactions") || request.url?.startsWith("/errors"))
    ) {
      const after = Number(new URL(request.url, "http://localhost").searchParams.get("after"));
      const storedEvents = request.url.startsWith("/transactions") ? transactions : errors;
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(storedEvents.filter(({ receivedAt }) => receivedAt >= after)));
      return;
    }

    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const envelope =
        request.headers["content-encoding"] === "gzip"
          ? gunzipSync(body).toString("utf8")
          : body.toString("utf8");
      const receivedAt = Date.now();
      for (const item of readEnvelopeItems(envelope)) {
        const destination = item.type === "transaction" ? transactions : errors;
        destination.push({ event: item.event, receivedAt });
        destination.splice(0, Math.max(0, destination.length - 100));
      }
      response.writeHead(200, { "access-control-allow-origin": "*" }).end("{}");
    });
  })
  .listen(3031);
