import { createServer, type Server } from "node:http";
import type { Request, Response } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Ported from Next.js: test/e2e/app-dir/app-basepath/index.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-basepath/index.test.ts

const BASE = "http://localhost:4190";
const EXTERNAL_PORT = 4191;

let externalServer: Server;

test.beforeAll(async () => {
  externalServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<h1>outside basePath</h1>");
  });
  await new Promise<void>((resolve) => externalServer.listen(EXTERNAL_PORT, "127.0.0.1", resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    externalServer.close((error) => (error ? reject(error) : resolve()));
  });
});

test.describe("app dir - basepath", () => {
  test("streams internal server action redirect() responses under basePath", async ({ page }) => {
    for (const buttonId of ["redirect-relative", "redirect-absolute-internal"]) {
      const requests: Request[] = [];
      const responses: Response[] = [];
      const initialPagePath = "/base/client";
      const destinationPagePath = "/base/another";

      await page.goto(`${BASE}${initialPagePath}`);
      await waitForAppRouterHydration(page);

      const onRequest = (req: Request) => {
        const url = req.url();
        if (url.includes(initialPagePath) || url.includes(destinationPagePath)) {
          requests.push(req);
        }
      };
      const onResponse = (res: Response) => {
        const url = res.url();
        if (url.includes(initialPagePath) || url.includes(destinationPagePath)) {
          responses.push(res);
        }
      };
      page.on("request", onRequest);
      page.on("response", onResponse);

      await page.locator(`#${buttonId}`).click();
      await expect(page).toHaveURL(new RegExp(`${BASE}/base/another$`));
      await expect(page.locator("#page-2")).toHaveText("Page 2");

      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(requests[0].url()).toBe(`${BASE}${initialPagePath}`);
      expect(requests[0].method()).toBe("POST");
      expect(responses[0].status()).toBe(303);

      page.off("request", onRequest);
      page.off("response", onResponse);
    }
  });

  test("redirects externally for absolute same-origin URLs outside basePath", async ({ page }) => {
    const initialPagePath = "/base/client";
    const destinationPagePath = "/outsideBasePath";
    const requests: Request[] = [];
    const responses: Response[] = [];

    await page.goto(`${BASE}${initialPagePath}`);
    await waitForAppRouterHydration(page);

    const onRequest = (req: Request) => {
      const url = req.url();
      if (url.includes(initialPagePath) || url.includes(destinationPagePath)) {
        requests.push(req);
      }
    };
    const onResponse = (res: Response) => {
      const url = res.url();
      if (url.includes(initialPagePath) || url.includes(destinationPagePath)) {
        responses.push(res);
      }
    };
    page.on("request", onRequest);
    page.on("response", onResponse);

    await page.locator("#redirect-absolute-external").click();
    await expect(page).toHaveURL(new RegExp(`${BASE}${destinationPagePath}$`));

    expect(requests).toHaveLength(2);
    expect(responses).toHaveLength(2);

    const [firstRequest, secondRequest] = requests;
    const [firstResponse, secondResponse] = responses;

    expect(firstRequest.url()).toBe(`${BASE}${initialPagePath}`);
    expect(firstRequest.method()).toBe("POST");

    expect(secondRequest.url()).toBe(`${BASE}${destinationPagePath}`);
    expect(secondRequest.method()).toBe("GET");

    expect(firstResponse.status()).toBe(303);
    expect(secondResponse.status()).toBe(200);
  });
});
