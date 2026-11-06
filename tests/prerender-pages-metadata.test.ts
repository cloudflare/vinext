import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type RequestListener, type Server } from "node:http";
import { localizePagesPath, prerenderPages } from "../packages/vinext/src/build/prerender.js";
import { pagesRouter } from "../packages/vinext/src/routing/pages-router.js";
import { resolveNextConfig, type NextConfig } from "../packages/vinext/src/config/next-config.js";

let root: string;
let server: Server | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-prerender-metadata-"));
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

function page(name: string, exports = ""): void {
  const file = path.join(root, "pages", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${exports}\nexport default function Page() { return null; }\n`);
}

async function render(
  handler: RequestListener,
  nextConfig: NextConfig = {},
  mode: "default" | "export" = "default",
) {
  server = createServer((req, res) => {
    // Real page renders confirm they used the requested URL; handlers can override.
    res.setHeader("x-vinext-prerender-rewritten", "0");
    return handler(req, res);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (address && typeof address === "object") resolve(address.port);
    });
  });
  const pagesDir = path.join(root, "pages");
  return prerenderPages({
    mode,
    routes: await pagesRouter(pagesDir),
    apiRoutes: [],
    pagesDir,
    outDir: path.join(root, "out"),
    config: await resolveNextConfig(nextConfig),
    _prodServer: { server, port },
    _prerenderSecret: "test-secret",
  });
}

describe("Pages prerender response metadata", () => {
  it("records a successful status and content type without request-specific headers", async () => {
    page("accepted.tsx");
    const result = await render((_req, res) => {
      res.writeHead(202, {
        "Content-Type": "application/xhtml+xml; charset=utf-8",
        "Set-Cookie": "build-only=do-not-replay",
        "X-Request-Id": "prerender-request",
      });
      res.end("<html>Accepted</html>");
    });

    expect(result.routes).toEqual([
      expect.objectContaining({ route: "/accepted", status: "rendered", responseStatus: 202 }),
    ]);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "out/vinext-prerender.json"), "utf8"),
    );
    expect(manifest.routes[0].responseStatus).toBe(202);
    expect(manifest.routes[0].headers).toEqual({
      "content-type": "application/xhtml+xml; charset=utf-8",
    });
  });

  it("leaves pages rendered through a rewrite to runtime", async () => {
    // A conditional beforeFiles rewrite (for example `missing: cookie`) can fire
    // for the headerless build request, but not for visitors carrying the cookie.
    page("account.tsx", "export function getStaticProps() { return { props: {} }; }");
    page("about.tsx", "export function getStaticProps() { return { props: {} }; }");
    const result = await render((req, res) => {
      const rewritten = req.url === "/account";
      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Vinext-Cache", "MISS");
      res.setHeader("x-vinext-prerender-rewritten", rewritten ? "1" : "0");
      res.end(rewritten ? "<html>Login</html>" : "<html>About</html>");
    });

    expect(result.routes).toEqual(
      expect.arrayContaining([
        { route: "/account", status: "skipped", reason: "dynamic" },
        expect.objectContaining({ route: "/about", status: "rendered" }),
      ]),
    );
    expect(fs.existsSync(path.join(root, "out/account.html"))).toBe(false);
    expect(fs.existsSync(path.join(root, "out/about.html"))).toBe(true);
  });

  it("leaves pages rewritten to a public file or API route to runtime", async () => {
    // Filesystem, API, and proxy rewrites return before the page renderer, so
    // their responses never carry the unrewritten-page confirmation.
    page("account.tsx", "export function getStaticProps() { return { props: {} }; }");
    page("billing.tsx", "export function getStaticProps() { return { props: {} }; }");
    page("about.tsx", "export function getStaticProps() { return { props: {} }; }");
    const result = await render((req, res) => {
      if (req.url === "/account" || req.url === "/billing") {
        res.removeHeader("x-vinext-prerender-rewritten");
      }
      res.setHeader("Content-Type", req.url === "/billing" ? "application/json" : "text/html");
      res.end(req.url === "/billing" ? '{"api":true}' : "<html>Public file</html>");
    });

    expect(result.routes).toEqual(
      expect.arrayContaining([
        { route: "/account", status: "skipped", reason: "dynamic" },
        { route: "/billing", status: "skipped", reason: "dynamic" },
        expect.objectContaining({ route: "/about", status: "rendered" }),
      ]),
    );
    expect(fs.existsSync(path.join(root, "out/account.html"))).toBe(false);
    expect(fs.existsSync(path.join(root, "out/billing.html"))).toBe(false);
  });

  it("does not package a rewritten 404 response as the custom 404", async () => {
    page("404.tsx");
    const result = await render((req, res) => {
      // e.g. a conditional rewrite of /404 to a public file returns early.
      if (req.url === "/404") res.removeHeader("x-vinext-prerender-rewritten");
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html");
      res.end("<html>Not the custom 404</html>");
    });

    expect(result.routes.find((route) => route.route === "/404")).toBeUndefined();
    expect(fs.existsSync(path.join(root, "out/404.html"))).toBe(false);
  });

  // Next.js: test/e2e/prerender.test.ts and test/e2e/i18n-data-fetching-redirect/redirect.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/prerender.test.ts
  it.each([undefined, true, false])(
    "records GSP terminal metadata and original redirect props (basePath: %s)",
    async (basePath) => {
      const redirectProps = {
        pageProps: {
          __N_REDIRECT: '/destination?value="quoted"&other=1',
          __N_REDIRECT_STATUS: 307,
          ...(basePath === undefined ? {} : { __N_REDIRECT_BASE_PATH: basePath }),
        },
        appValue: { preserved: true },
        __N_SSG: true,
      };
      for (const name of ["redirect", "missing", "404"]) {
        page(`${name}.tsx`, "export function getStaticProps() { return { props: {} }; }");
      }
      const result = await render((req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.setHeader("X-Vinext-Cache", "MISS");
        if (req.url === "/redirect") {
          res.writeHead(307, {
            Location: '/destination?value="quoted"&other=1',
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify(redirectProps));
        } else {
          res.statusCode = 404;
          res.end("<html>Custom not found</html>");
        }
      });

      expect(result.routes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            route: "/redirect",
            status: "rendered",
            responseStatus: 307,
            redirectProps,
            headers: { location: '/destination?value="quoted"&other=1' },
          }),
          expect.objectContaining({ route: "/missing", status: "rendered", notFound: true }),
          expect.objectContaining({ route: "/404", status: "rendered" }),
        ]),
      );
      expect(result.routes.find((route) => route.route === "/404")).not.toHaveProperty("notFound");
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, "out/vinext-prerender.json"), "utf8"),
      );
      expect(
        manifest.routes.find((route: { route: string }) => route.route === "/404").headers,
      ).toEqual({ "content-type": "text/html" });
      expect(
        manifest.routes.find((route: { route: string }) => route.route === "/missing"),
      ).toMatchObject({
        notFound: true,
        responseStatus: 404,
      });
      expect(
        manifest.routes.find((route: { route: string }) => route.route === "/redirect")
          .redirectProps,
      ).toEqual(redirectProps);
      expect(fs.readFileSync(path.join(root, "out/redirect.html"), "utf8")).toContain(
        "url=/destination?value=&quot;quoted&quot;&amp;other=1",
      );
      expect(fs.readFileSync(path.join(root, "out/missing.html"), "utf8")).toContain(
        "Custom not found",
      );
    },
  );

  it.each([
    "not json",
    "null",
    "[]",
    "{}",
    '{"pageProps":{}}',
    '{"pageProps":{"__N_REDIRECT":"/target","__N_REDIRECT_STATUS":308}}',
    '{"pageProps":{"__N_REDIRECT":"/target","__N_REDIRECT_STATUS":307,"__N_REDIRECT_BASE_PATH":"false"}}',
  ])("rejects malformed internal redirect props: %s", async (body) => {
    page("redirect.tsx", "export function getStaticProps() { return { props: {} }; }");
    const result = await render((_req, res) => {
      res.writeHead(307, {
        Location: "/target",
        "X-Vinext-Cache": "MISS",
        "Content-Type": "application/json",
      });
      res.end(body);
    });
    expect(result.routes).toEqual([
      expect.objectContaining({ route: "/redirect", status: "error" }),
    ]);
    expect(fs.existsSync(path.join(root, "out/redirect.html"))).toBe(false);
  });

  it("does not admit terminal responses that bypassed getStaticProps", async () => {
    page("redirect.tsx", "export function getStaticProps() { return { props: {} }; }");
    page("missing.tsx", "export function getStaticProps() { return { props: {} }; }");
    page("initial-props.tsx");
    const result = await render((req, res) => {
      if (req.url === "/initial-props") res.setHeader("X-Vinext-Cache", "MISS");
      if (req.url === "/missing") {
        res.statusCode = 404;
      } else {
        res.writeHead(307, { Location: "/runtime-destination" });
      }
      res.end("runtime response");
    });

    for (const route of result.routes) {
      expect(route).not.toHaveProperty("notFound");
      expect(route).not.toHaveProperty("responseStatus");
      expect(route).not.toHaveProperty("headers");
    }
  });

  it("keeps export redirect shells and export notFound behavior unchanged", async () => {
    page("redirect.tsx", "export function getStaticProps() { return { props: {} }; }");
    page("missing.tsx", "export function getStaticProps() { return { props: {} }; }");
    const result = await render(
      (req, res) => {
        res.setHeader("X-Vinext-Cache", "MISS");
        if (req.url === "/redirect") res.writeHead(308, { Location: "/destination" });
        else res.statusCode = 404;
        res.end("response");
      },
      {},
      "export",
    );

    expect(result.routes.find((route) => route.route === "/missing")).toMatchObject({
      status: "error",
    });
    expect(fs.existsSync(path.join(root, "out/missing.html"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "out/redirect.html"), "utf8")).toContain(
      "url=/destination",
    );
  });
});

describe("Pages prerender locales", () => {
  it("keeps canonical default-locale URLs unless a segment names a locale", () => {
    const i18n = { locales: ["en", "fr"], defaultLocale: "en", localeDetection: false as const };
    expect(localizePagesPath("/", "en", i18n)).toBe("/");
    expect(localizePagesPath("/about", "en", i18n)).toBe("/about");
    expect(localizePagesPath("/fr", "en", i18n)).toBe("/en/fr");
    expect(localizePagesPath("/FR/about", "en", i18n)).toBe("/en/FR/about");
    expect(localizePagesPath("/en", "en", i18n)).toBe("/en/en");
    expect(localizePagesPath("/", "fr", i18n)).toBe("/fr");
    expect(localizePagesPath("/about", "fr", i18n)).toBe("/fr/about");
  });

  // Next.js: test/e2e/i18n-support/i18n-support.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/i18n-support/i18n-support.test.ts
  it("enumerates static locales and retains dynamic object/string locales", async () => {
    page("index.tsx");
    page("404.tsx");
    page("posts/[slug].tsx", "export function getStaticProps() { return { props: {} }; }");
    const requested: string[] = [];
    let staticPathsContext: URLSearchParams | undefined;
    const result = await render(
      (req, res) => {
        const url = new URL(req.url!, "http://localhost");
        if (url.pathname === "/__vinext/prerender/pages-static-paths") {
          staticPathsContext = url.searchParams;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              paths: [
                { params: { slug: "default" } },
                { params: { slug: "fr-object" }, locale: "fr" },
                "/fr/posts/fr-string",
                "/en/posts/en-string",
              ],
              fallback: false,
            }),
          );
          return;
        }
        requested.push(url.pathname);
        if (url.pathname.endsWith("/404")) res.statusCode = 404;
        res.setHeader("Content-Type", "text/html");
        res.end(`<html>${url.pathname}</html>`);
      },
      { i18n: { locales: ["en", "fr"], defaultLocale: "en", localeDetection: false } },
    );

    expect(staticPathsContext?.get("locales")).toBe('["en","fr"]');
    expect(staticPathsContext?.get("defaultLocale")).toBe("en");
    expect(requested.sort()).toEqual(
      [
        "/",
        "/404",
        "/fr",
        "/fr/404",
        "/fr/posts/fr-object",
        "/fr/posts/fr-string",
        "/posts/default",
        "/posts/en-string",
      ].sort(),
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "out/vinext-prerender.json"), "utf8"),
    );
    expect(
      manifest.routes.filter((route: { locale: string }) => route.locale === "fr"),
    ).toHaveLength(4);
    expect(result.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ route: "/", path: "/fr", locale: "fr", status: "rendered" }),
        expect.objectContaining({
          route: "/404",
          path: "/fr/404",
          locale: "fr",
          status: "rendered",
        }),
        expect.objectContaining({
          route: "/posts/:slug",
          path: "/fr/posts/fr-object",
          locale: "fr",
        }),
      ]),
    );
  });
});
