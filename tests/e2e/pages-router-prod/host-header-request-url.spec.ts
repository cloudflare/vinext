import { expect, test } from "@playwright/test";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

function getWithHost(
  baseURL: string,
  path: string,
  host: string,
): Promise<{ body: string; headers: IncomingHttpHeaders; status: number }> {
  const { hostname, port } = new URL(baseURL);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ headers: { host }, host: hostname, path, port }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ body, headers: res.headers, status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end();
  });
}

// Next.js builds the middleware URL from its own hostname, so the Host header
// never changes the pathname middleware matches. vinext keeps Host for the
// origin only.
test("a Host header cannot move the request path away from Pages middleware", async ({
  baseURL,
}) => {
  const origin = baseURL ?? "http://localhost:4175";
  const { host } = new URL(origin);

  for (const hostHeader of [
    host,
    `${host}?`,
    `${host}#`,
    `${host}/api?`,
    `${host}/zzz#`,
    `${host}\\zzz`,
  ]) {
    const blocked = await getWithHost(origin, "/middleware-protected-data", hostHeader);
    expect({ hostHeader, status: blocked.status, body: blocked.body }).toEqual({
      hostHeader,
      status: 403,
      body: "Access Denied",
    });

    // A beforeFiles rewrite source must pass middleware on the same pathname.
    const rewritten = await getWithHost(origin, "/before-rewrite", hostHeader);
    expect({ hostHeader, status: rewritten.status }).toEqual({ hostHeader, status: 200 });
    expect(rewritten.headers["x-mw-pathname"]).toBe("/before-rewrite");
    expect(rewritten.body).toContain("About");
  }
});
