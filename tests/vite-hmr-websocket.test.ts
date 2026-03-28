import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { APP_FIXTURE_DIR, startFixtureServer } from "./helpers";

function readUpgradeResponse(
  host: string,
  port: number,
  requestPath: string,
  origin?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let data = "";
    let settled = false;

    const finish = (fn: (value: any) => void, value: any) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    };

    socket.setTimeout(5_000, () => finish(reject, new Error("socket timeout")));

    socket.on("connect", () => {
      const lines = [
        `GET ${requestPath} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Protocol: vite-hmr",
      ];
      if (origin) lines.push(`Origin: ${origin}`);
      socket.write(lines.join("\r\n") + "\r\n\r\n");
    });

    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.includes("\r\n\r\n")) {
        finish(resolve, data);
      }
    });

    socket.on("error", (error) => finish(reject, error));
    socket.on("close", () => finish(resolve, data));
  });
}

async function extractViteWsToken(baseUrl: string): Promise<string> {
  const clientCode = await fetch(`${baseUrl}/@vite/client`).then((res) => res.text());
  const match = clientCode.match(/const wsToken = ["']([^"']+)["']/);
  if (!match) {
    throw new Error("Failed to extract Vite websocket token from /@vite/client");
  }
  return match[1];
}

describe("Vite HMR websocket token checks", () => {
  let server: Awaited<ReturnType<typeof startFixtureServer>>["server"];
  let host: string;
  let port: number;
  let token: string;

  beforeAll(async () => {
    const started = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true });
    server = started.server;

    const url = new URL(started.baseUrl);
    host = url.hostname;
    port = Number(url.port);
    token = await extractViteWsToken(started.baseUrl);
  });

  afterAll(async () => {
    await server.close();
  });

  it("rejects websocket upgrade with Origin header when token is missing", async () => {
    const response = await readUpgradeResponse(host, port, "/", "http://evil.example");
    expect(response.startsWith("HTTP/1.1 400")).toBe(true);
  });

  it("rejects websocket upgrade with Origin header when token is invalid", async () => {
    const response = await readUpgradeResponse(
      host,
      port,
      "/?token=not-the-real-token",
      "http://evil.example",
    );
    expect(response.startsWith("HTTP/1.1 400")).toBe(true);
  });

  it("accepts websocket upgrade with a valid token", async () => {
    const response = await readUpgradeResponse(
      host,
      port,
      `/?token=${encodeURIComponent(token)}`,
      "http://localhost:3000",
    );
    expect(response.startsWith("HTTP/1.1 101")).toBe(true);
  });
});
