import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vite-plus/test";
import { removeRequestHeaders } from "../packages/vinext/src/server/remove-request-headers.js";

describe("removeRequestHeaders", () => {
  it("removes headers from HTTP/2 compatibility requests, which have no headersDistinct", async () => {
    let removalError: unknown;
    let header: unknown;
    let rawHeaders: string[] = [];
    const server = http2.createServer((req, res) => {
      try {
        removeRequestHeaders(req, new Set(["x-internal"]));
        header = req.headers["x-internal"];
        rawHeaders = [...req.rawHeaders];
      } catch (error) {
        removalError = error;
      }
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    try {
      await new Promise<void>((resolve, reject) => {
        const stream = client.request({ ":path": "/", "x-internal": "1", "x-client": "1" });
        stream.on("end", resolve);
        stream.on("error", reject);
        stream.resume();
        stream.end();
      });
      expect(removalError).toBeUndefined();
      expect(header).toBeUndefined();
      expect(rawHeaders).toContain("x-client");
      expect(rawHeaders).not.toContain("x-internal");
    } finally {
      client.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
