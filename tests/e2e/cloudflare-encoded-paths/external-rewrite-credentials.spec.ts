import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { expect, test } from "@playwright/test";

// Matches the external rewrite destinations in tests/fixtures/cf-app-basic/next.config.ts.
const EXTERNAL_ORIGIN_PORT = 43198;
const PHASES = ["before-files", "after-files", "fallback"] as const;

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// Next.js applies middleware's request header override before any config
// rewrite runs, so an external origin only receives the post-middleware request.
test("external config rewrites forward the request headers middleware produced", async ({
  request,
}) => {
  const captures = new Map<string, IncomingHttpHeaders>();
  const externalOrigin = createServer((incoming, response) => {
    captures.set(incoming.url ?? "", incoming.headers);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("external origin");
  });
  await new Promise<void>((resolve, reject) => {
    externalOrigin.once("error", reject);
    externalOrigin.listen(EXTERNAL_ORIGIN_PORT, "127.0.0.1", resolve);
  });

  try {
    for (const phase of PHASES) {
      for (const strip of [false, true]) {
        captures.clear();
        const response = await request.get(`/external-credentials/${phase}`, {
          headers: {
            authorization: "Bearer first-party-token",
            cookie: "session=first-party-session",
            "x-kept": "kept",
            ...(strip ? { "x-test-strip-credentials": "1" } : {}),
          },
        });
        expect(response.status()).toBe(200);
        expect(await response.text()).toBe("external origin");

        const forwarded = captures.get(`/${phase}`);
        expect(forwarded?.["x-kept"]).toBe("kept");
        expect({
          authorization: forwarded?.authorization,
          cookie: forwarded?.cookie,
        }).toEqual(
          strip
            ? { authorization: undefined, cookie: undefined }
            : {
                authorization: "Bearer first-party-token",
                cookie: "session=first-party-session",
              },
        );
      }
    }
  } finally {
    await closeServer(externalOrigin);
  }
});
