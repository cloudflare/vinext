import { createServer } from "node:http";
import { gzipSync } from "node:zlib";

const port = 8788;
const json = Buffer.from('{"ok":true}\n');
const gzip = gzipSync(json);
const gzipGzip = gzipSync(gzip);

createServer((request, response) => {
  const stacked = request.url === "/stacked";
  const body = stacked ? gzipGzip : gzip;

  response.writeHead(200, {
    "content-type": "application/json",
    // Node emits two header fields for the stacked case. Fetch exposes them as
    // the equivalent list value `gzip, gzip`.
    "content-encoding": stacked ? ["gzip", "gzip"] : "gzip",
    "content-length": String(body.byteLength),
  });
  response.end(body);
}).listen(port, "127.0.0.1", () => {
  console.log(`Origin listening on http://127.0.0.1:${port}`);
});
