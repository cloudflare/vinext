import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/proxy-conventions");
const APP_FIXTURE_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "./fixtures/app-basic/node_modules",
);

let server: ViteDevServer | undefined;
let fixtureDir: string | undefined;

async function waitForResponse(
  url: string,
  predicate: (response: Response, body: string) => boolean,
): Promise<{ response: Response; body: string }> {
  const deadline = Date.now() + 5000;
  let lastResponse: Response | undefined;
  let lastBody = "";
  while (Date.now() < deadline) {
    lastResponse = await fetch(url);
    lastBody = await lastResponse.text();
    if (predicate(lastResponse, lastBody)) return { response: lastResponse, body: lastBody };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for response from ${url}; last status=${lastResponse?.status}, body=${lastBody}`,
  );
}

async function createFixture(): Promise<string> {
  fixtureDir = await createIsolatedFixture(
    FIXTURE_DIR,
    "vinext-proxy-conventions-",
    undefined,
    APP_FIXTURE_NODE_MODULES,
  );
  await fs.writeFile(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({ name: "proxy-conventions-fixture", private: true, type: "module" }),
  );
  return fixtureDir;
}

async function startFixture(root: string, appDir?: string | null): Promise<string> {
  const result = await startFixtureServer(root, { appDir });
  server = result.server;
  return result.baseUrl;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

describe("App Router proxy file convention", () => {
  // Ported from Next.js: test/e2e/app-dir/app-middleware-proxy/
  // app-middleware-proxy-without-pages-dir.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-middleware-proxy/app-middleware-proxy-without-pages-dir.test.ts
  it("runs a named proxy export and respects its matcher", async () => {
    const root = await createFixture();
    await fs.writeFile(
      path.join(root, "proxy.js"),
      `import { NextResponse } from "next/server";

export function proxy() {
  return new NextResponse("proxied response", {
    headers: { "x-proxy-ran": "true" },
  });
}

export const config = { matcher: "/headers" };
`,
    );

    const baseUrl = await startFixture(root);
    const matched = await fetch(`${baseUrl}/headers`);
    expect(matched.status).toBe(200);
    expect(matched.headers.get("x-proxy-ran")).toBe("true");
    expect(await matched.text()).toBe("proxied response");

    const unmatched = await fetch(`${baseUrl}/`);
    expect(unmatched.status).toBe(200);
    expect(unmatched.headers.get("x-proxy-ran")).toBeNull();
    expect(await unmatched.text()).toContain("hello world");
  });

  // Ported from Next.js: test/e2e/app-dir/app-middleware-proxy/
  // app-middleware-proxy-in-src-dir.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-middleware-proxy/app-middleware-proxy-in-src-dir.test.ts
  it("discovers src/proxy.js and provides RequestStore to next/headers", async () => {
    const root = await createFixture();
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.rename(path.join(root, "app"), path.join(root, "src", "app"));
    await fs.writeFile(
      path.join(root, "src", "proxy.js"),
      `import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function proxy() {
  const cookie = (await cookies()).get("test-cookie");
  return NextResponse.json({ cookie });
}
`,
    );

    const baseUrl = await startFixture(root, null);
    const response = await fetch(`${baseUrl}/`, {
      headers: { cookie: "test-cookie=test-cookie-response" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      cookie: { name: "test-cookie", value: "test-cookie-response" },
    });
  });

  // Ported from Next.js: test/e2e/app-dir/proxy-missing-export/
  // proxy-missing-export.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/proxy-missing-export/proxy-missing-export.test.ts
  it.each([
    ["default function", "export default function handler() {}"],
    ["default arrow function", "export default () => {}"],
    ["named function expression", "const proxy = function() {}; export { proxy };"],
    ["named arrow function", "const proxy = () => {}; export { proxy };"],
  ])("accepts a %s export", async (_name, source) => {
    const root = await createFixture();
    await fs.writeFile(path.join(root, "proxy.ts"), source);

    const baseUrl = await startFixture(root);
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hello world");
  });

  // Ported from Next.js: test/e2e/app-dir/proxy-missing-export/
  // proxy-missing-export.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/proxy-missing-export/proxy-missing-export.test.ts
  it.each([
    ["middleware named export", "export function middleware() {}"],
    ["aliased named export", "const proxy = () => {}; export { proxy as handler };"],
  ])("rejects an invalid proxy export: %s", async (_name, source) => {
    const root = await createFixture();
    await fs.writeFile(path.join(root, "proxy.ts"), source);

    const baseUrl = await startFixture(root);
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(500);
    const errorBody = await response.text();
    const canonicalError =
      'The file "./proxy.ts" must export a function, either as a default export or as a named "proxy" export.';
    expect(errorBody).toContain(JSON.stringify(canonicalError).slice(1, -1));
    expect(errorBody).toContain(
      "You are migrating from `middleware` to `proxy`, but haven't updated the exported function.",
    );
    expect(errorBody).toContain("https://nextjs.org/docs/messages/middleware-to-proxy");
    expect(errorBody).toContain('"plugin":"vinext:validate-middleware-exports"');
  });

  it("recovers after proxy.ts changes from an invalid to a valid export", async () => {
    const root = await createFixture();
    const proxyPath = path.join(root, "proxy.ts");
    await fs.writeFile(proxyPath, "export function middleware() {}\n");

    const baseUrl = await startFixture(root);
    const invalid = await fetch(`${baseUrl}/`);
    expect(invalid.status).toBe(500);
    expect(await invalid.text()).toContain("vinext:validate-middleware-exports");

    await fs.writeFile(
      proxyPath,
      `export function proxy() { return new Response("proxy recovered"); }\n`,
    );

    const recovered = await waitForResponse(
      `${baseUrl}/`,
      (response, body) => response.status === 200 && body === "proxy recovered",
    );
    expect(recovered.body).toBe("proxy recovered");
  });

  it("recovers after middleware.ts changes from an invalid to a valid export", async () => {
    const root = await createFixture();
    const middlewarePath = path.join(root, "middleware.ts");
    await fs.writeFile(middlewarePath, "export function proxy() {}\n");

    const baseUrl = await startFixture(root);
    const invalid = await fetch(`${baseUrl}/`);
    expect(invalid.status).toBe(500);
    expect(await invalid.text()).toContain("vinext:validate-middleware-exports");

    await fs.writeFile(
      middlewarePath,
      `export function middleware() { return new Response("middleware recovered"); }\n`,
    );

    const recovered = await waitForResponse(
      `${baseUrl}/`,
      (response, body) => response.status === 200 && body === "middleware recovered",
    );
    expect(recovered.body).toBe("middleware recovered");
  });

  it("runs proxy files with compound pageExtensions", async () => {
    const root = await createFixture();
    await fs.writeFile(
      path.join(root, "next.config.mjs"),
      `export default { pageExtensions: ["platform.tsx", "tsx", "ts", "jsx", "js"] };\n`,
    );
    await fs.writeFile(
      path.join(root, "proxy.platform.tsx"),
      `import { NextResponse } from "next/server";

export function proxy() {
  return new NextResponse("compound proxy");
}
`,
    );

    const baseUrl = await startFixture(root);
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("compound proxy");
  });

  it("uses the root proxy when root and src conventions both exist", async () => {
    const root = await createFixture();
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "proxy.ts"),
      `export default function proxy() { return new Response("root proxy"); }`,
    );
    await fs.writeFile(
      path.join(root, "src", "proxy.ts"),
      `export default function proxy() { return new Response("src proxy"); }`,
    );

    const baseUrl = await startFixture(root);
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("root proxy");
  });

  it("keeps proxy discovery at the project convention level with a custom appDir", async () => {
    const root = await createFixture();
    const customBase = path.join(root, "custom-base");
    await fs.mkdir(customBase, { recursive: true });
    await fs.rename(path.join(root, "app"), path.join(customBase, "app"));
    await fs.writeFile(
      path.join(root, "proxy.ts"),
      `export default function proxy() { return new Response("root convention proxy"); }`,
    );
    await fs.writeFile(
      path.join(customBase, "proxy.ts"),
      `export default function proxy() { return new Response("custom appDir proxy"); }`,
    );

    const baseUrl = await startFixture(root, customBase);
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("root convention proxy");
  });

  it("uses the first configured pageExtension when multiple proxy files exist", async () => {
    const root = await createFixture();
    await fs.writeFile(
      path.join(root, "next.config.mjs"),
      `export default { pageExtensions: ["js", "ts", "tsx", "jsx"] };\n`,
    );
    await fs.writeFile(
      path.join(root, "proxy.js"),
      `export default function proxy() { return new Response("js proxy"); }`,
    );
    await fs.writeFile(
      path.join(root, "proxy.ts"),
      `export default function proxy() { return new Response("ts proxy"); }`,
    );

    const baseUrl = await startFixture(root);
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("js proxy");
  });

  // Ported from Next.js: test/e2e/app-dir/proxy-with-middleware/
  // proxy-with-middleware.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/proxy-with-middleware/proxy-with-middleware.test.ts
  it("rejects projects containing both middleware and proxy files", async () => {
    const root = await createFixture();
    await fs.writeFile(path.join(root, "proxy.ts"), "export function proxy() {}");
    await fs.writeFile(path.join(root, "middleware.ts"), "export function middleware() {}");

    await expect(startFixtureServer(root)).rejects.toThrow(
      'Both middleware file "./middleware.ts" and proxy file "./proxy.ts" are detected. Please use "./proxy.ts" only.',
    );
  });
});
