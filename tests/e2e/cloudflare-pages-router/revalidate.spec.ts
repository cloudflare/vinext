import { createServer, request as sendHttpRequest, type Server } from "node:http";
import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4177";

function extractToken(html: string): string {
  const match = html.match(/<p id="revalidate-token">([^<]+)<\/p>/);
  if (!match) throw new Error("Missing revalidation token");
  return match[1];
}

async function requestWithHost(
  host: string,
  path: string,
): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const request = sendHttpRequest(
      {
        hostname: "127.0.0.1",
        port: 4177,
        path,
        headers: { host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("revalidates inside the Worker without sending its credential to the request origin", async ({
  request,
}) => {
  const capturedHeaders: Array<string | undefined> = [];
  const outsideServer = createServer((incoming, response) => {
    const value = incoming.headers["x-prerender-revalidate"];
    capturedHeaders.push(Array.isArray(value) ? value[0] : value);
    response.writeHead(200);
    response.end("outside");
  });
  await new Promise<void>((resolve) => outsideServer.listen(0, "127.0.0.1", resolve));
  const address = outsideServer.address();
  if (!address || typeof address === "string") throw new Error("Expected outside TCP server");

  try {
    const before = await request.get(`${BASE}/revalidate-target`);
    expect(before.status()).toBe(200);
    const beforeToken = extractToken(await before.text());

    const result = await requestWithHost(
      `127.0.0.1:${address.port}`,
      `/api/revalidate?path=${encodeURIComponent("/revalidate-target")}`,
    );
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ revalidated: true });
    expect(capturedHeaders).toEqual([]);

    const after = await request.get(`${BASE}/revalidate-target`);
    expect(after.status()).toBe(200);
    expect(extractToken(await after.text())).not.toBe(beforeToken);
  } finally {
    await closeServer(outsideServer);
  }
});
