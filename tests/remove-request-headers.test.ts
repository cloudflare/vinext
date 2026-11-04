import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vite-plus/test";
import { removeRequestHeaders } from "../packages/vinext/src/server/remove-request-headers.js";

describe("removeRequestHeaders", () => {
  it("removes headers from HTTP/2 compatibility requests, which have no headersDistinct", async () => {
    const server = http2.createServer((req, res) => {
      try {
        removeRequestHeaders(req, new Set(["x-internal"]));
        res.end(
          JSON.stringify({ header: req.headers["x-internal"] ?? null, rawHeaders: req.rawHeaders }),
        );
      } catch (error) {
        res.end(JSON.stringify({ error: String(error) }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const stream = client.request({ ":path": "/", "x-internal": "1", "x-client": "1" });
        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => (data += chunk));
        stream.on("end", () => resolve(data));
        stream.on("error", reject);
        stream.end();
      });
      expect(JSON.parse(body)).toEqual({
        header: null,
        rawHeaders: expect.arrayContaining(["x-client"]),
      });
      expect(JSON.parse(body).rawHeaders).not.toContain("x-internal");
    } finally {
      client.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
