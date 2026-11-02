import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vite-plus/test";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

const SERVER_ENTRIES = {
  app: ["server/index.js", "export default () => new Response('pong');"],
  pages: ["server/entry.js", "export const vinextConfig = {};"],
} as const;

function createBuild(router: keyof typeof SERVER_ENTRIES): string {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `vinext-prerender-keep-alive-${router}-`));
  const [entry, source] = SERVER_ENTRIES[router];
  fs.mkdirSync(path.join(outDir, "server"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "client"), { recursive: true });
  fs.writeFileSync(path.join(outDir, entry), source);
  fs.writeFileSync(path.join(outDir, "client/ping.txt"), "pong");
  return outDir;
}

// Sends one keep-alive request on an already open socket and resolves with
// the response, or rejects if the server has closed the socket.
function request(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) return reject(new Error("server closed the idle socket"));
    let response = "";
    const onData = (chunk: Buffer) => {
      response += chunk.toString();
      if (!response.includes("pong")) return;
      socket.off("data", onData).off("close", onClose);
      resolve(response);
    };
    const onClose = () => reject(new Error("server closed the idle socket"));
    socket.on("data", onData).once("close", onClose);
    socket.write("GET /ping.txt HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  });
}

describe("prerender server keep-alive", () => {
  // The build's fetch pool reuses idle sockets. If the server expires one
  // while the event loop is blocked by a render, the reused request fails with
  // ECONNRESET and the page is dropped from the build. #4118
  it.concurrent.each(["app", "pages"] as const)(
    "keeps idle %s sockets open past Node's default keep-alive timeout",
    async (router) => {
      const outDir = createBuild(router);
      const { server, port } = await startProdServer({
        port: 0,
        host: "127.0.0.1",
        outDir,
        noCompression: true,
        silent: true,
        purpose: "prerender",
      });
      const socket = net.connect(port, "127.0.0.1");
      try {
        expect(await request(socket)).toMatch(/^HTTP\/1\.1 200 /);
        // Node's default keepAliveTimeout (5s) plus keepAliveTimeoutBuffer (1s).
        await sleep(6_500);
        expect(await request(socket)).toMatch(/^HTTP\/1\.1 200 /);
      } finally {
        socket.destroy();
        server.closeAllConnections();
        server.close();
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
