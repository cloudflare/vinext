import { createServer, request as sendHttpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

const APP_PORT = 4198;

function requestWithHost(host: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = sendHttpRequest(
      { hostname: "127.0.0.1", port: APP_PORT, path, headers: { host } },
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

// Next.js only attaches `res.revalidate()` in apiResolver
// (packages/next/src/server/api-utils/node/api-resolver.ts), so a hybrid
// Pages page's getServerSideProps `res` cannot send the revalidation secret.
test("hybrid Pages getServerSideProps res has no revalidate() and never contacts the Host origin", async () => {
  let capturedRevalidateHeader: string | undefined;
  const outsideServer = createServer((request, response) => {
    const header = request.headers["x-prerender-revalidate"];
    capturedRevalidateHeader = Array.isArray(header) ? header[0] : header;
    response.writeHead(200);
    response.end();
  });
  await new Promise<void>((resolve) => outsideServer.listen(0, "127.0.0.1", resolve));

  try {
    const outsidePort = (outsideServer.address() as AddressInfo).port;
    const result = await requestWithHost(`127.0.0.1:${outsidePort}`, "/pages-gssp-res-revalidate");

    expect(capturedRevalidateHeader).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.body).toMatch(/res\.revalidate: (?:<!-- -->)?undefined/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      outsideServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
