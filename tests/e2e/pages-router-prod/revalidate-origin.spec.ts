import { createServer, request as sendHttpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

const APP_PORT = 4175;

function requestWithHost(
  host: string,
  path = "/api/revalidate-reason",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = sendHttpRequest(
      {
        hostname: "127.0.0.1",
        port: APP_PORT,
        path,
        headers: { host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("on-demand revalidation uses the bound production server origin", async () => {
  let capturedRevalidateHeader: string | undefined;
  const outsideServer = createServer((request, response) => {
    const header = request.headers["x-prerender-revalidate"];
    capturedRevalidateHeader = Array.isArray(header) ? header[0] : header;
    response.writeHead(418);
    response.end();
  });
  await new Promise<void>((resolve) => outsideServer.listen(0, "127.0.0.1", resolve));

  try {
    const outsidePort = (outsideServer.address() as AddressInfo).port;
    const result = await requestWithHost(`127.0.0.1:${outsidePort}`);

    expect(capturedRevalidateHeader).toBeUndefined();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ revalidated: true });
  } finally {
    await new Promise<void>((resolve, reject) =>
      outsideServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("on-demand revalidation keeps path inputs on the production server origin", async () => {
  let capturedRevalidateHeader: string | undefined;
  const outsideServer = createServer((request, response) => {
    const header = request.headers["x-prerender-revalidate"];
    capturedRevalidateHeader = Array.isArray(header) ? header[0] : header;
    response.writeHead(418);
    response.end();
  });
  await new Promise<void>((resolve) => outsideServer.listen(0, "127.0.0.1", resolve));

  try {
    const outsidePort = (outsideServer.address() as AddressInfo).port;
    const revalidatePath = `//127.0.0.1:${outsidePort}/outside`;
    const result = await requestWithHost(
      `localhost:${APP_PORT}`,
      `/api/revalidate-reason?path=${encodeURIComponent(revalidatePath)}`,
    );

    expect(capturedRevalidateHeader).toBeUndefined();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ revalidated: false });
  } finally {
    await new Promise<void>((resolve, reject) =>
      outsideServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
