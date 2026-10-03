import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { runPrerender } from "../packages/vinext/src/build/run-prerender.js";

type ManifestRoute = {
  route: string;
  status: string;
  rewrite?: { source: string; cachePathname: string };
};

function write(root: string, relativePath: string, contents: string): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/** `depth` is the count of directories between the page file and `app/`. */
const LOCALE_PAGE = (
  label: string,
  depth: number,
) => `import { Pathname } from "${"../".repeat(depth)}pathname";

export function generateStaticParams() {
  return [{ locale: "en" }, { locale: "es" }];
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return (
    <main>
      <p>{\`page:${label}:\${locale}\`}</p>
      <Pathname />
    </main>
  );
}
`;

/** Create an app in a temporary directory, build it, and prerender it. */
async function buildFixture(
  nextConfig: string,
  files: Record<string, string>,
): Promise<{ root: string; routes: ManifestRoute[] }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-rewrite-prerender-cache-"));
  write(root, "package.json", JSON.stringify({ name: "rewrite-prerender-cache", type: "module" }));
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  write(root, "next.config.mjs", nextConfig);
  write(
    root,
    "app/layout.tsx",
    `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  write(
    root,
    "app/pathname.tsx",
    `"use client";
import { usePathname } from "next/navigation";

export function Pathname() {
  return <p>{\`pathname:\${usePathname()}\`}</p>;
}
`,
  );
  for (const [relativePath, contents] of Object.entries(files)) write(root, relativePath, contents);

  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [vinext({ appDir: root })],
    logLevel: "silent",
  });
  await builder.buildApp();
  const result = await runPrerender({ root });
  return { root, routes: (result?.routes ?? []) as ManifestRoute[] };
}

async function startServer(root: string): Promise<{ server: Server; baseUrl: string }> {
  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const { server } = await startProdServer({
    port: 0,
    outDir: path.join(root, "dist"),
    noCompression: true,
    silent: true,
  });
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
  };
}

/**
 * A file that fixture code appends to when it runs. The prerender must not run
 * code that it did not run before this change, such as a route handler.
 */
function createCallLog(): { read: () => string; remove: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-rewrite-call-log-"));
  const file = path.join(directory, "calls.log");
  fs.writeFileSync(file, "");
  process.env.VINEXT_TEST_CALL_LOG = file;
  return {
    read: () => fs.readFileSync(file, "utf8"),
    remove: () => {
      delete process.env.VINEXT_TEST_CALL_LOG;
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function stop(server: Server | undefined, root: string): Promise<void> {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (root) fs.rmSync(root, { recursive: true, force: true });
}

// Ported from the reproduction in https://github.com/cloudflare/vinext/issues/3672:
// the default locale is served without a prefix through next.config rewrites.
const UNPREFIXED_DEFAULT_LOCALE_RULES = `
        { source: "/", destination: "/en" },
        {
          source: "/:path((?!en$|en/|es$|es/|api$|api/|_next/).*)",
          destination: "/en/:path",
        },`;

describe.each([
  { label: "default config", basePath: "", trailingSlash: false },
  // Both options change the URL that the build requests and the pathname that
  // the request handler keys the render by.
  { label: "basePath and trailingSlash", basePath: "/docs", trailingSlash: true },
])(
  "prerendered App pages reached through next.config rewrites ($label)",
  ({ basePath, trailingSlash }) => {
    let root = "";
    let routes: ManifestRoute[] = [];
    let server: Server | undefined;
    let baseUrl = "";
    let callLog: ReturnType<typeof createCallLog> | undefined;
    let callsDuringBuild = "";

    const url = (pathname: string) => {
      if (pathname === "/") return `${baseUrl}${basePath}${trailingSlash || !basePath ? "/" : ""}`;
      return `${baseUrl}${basePath}${pathname}${trailingSlash ? "/" : ""}`;
    };

    beforeAll(async () => {
      callLog = createCallLog();
      ({ root, routes } = await buildFixture(
        `export default {
  basePath: ${JSON.stringify(basePath)},
  trailingSlash: ${JSON.stringify(trailingSlash)},
  async redirects() {
    // The build request for this rewrite source gets a redirect, not a render.
    return [{ source: "/legacy", destination: "/about", permanent: false }];
  },
  async rewrites() {
    return {
      afterFiles: [
        // A request without the cookie, such as the build request, takes the first rule.
        { source: "/promo", missing: [{ type: "cookie", key: "seen" }], destination: "/en/about" },
        { source: "/promo", destination: "/en/contact" },
        // An empty catch-all rewrites "/shop" to "/en/shop/", with a trailing slash.
        { source: "/shop/:path*", destination: "/en/shop/:path*" },
        // The runtime does not add a trailing slash to a path below "/api".
        { source: "/api/info", destination: "/en/about" },${UNPREFIXED_DEFAULT_LOCALE_RULES}
      ],
    };
  },
};
`,
        {
          "app/[locale]/page.tsx": LOCALE_PAGE("home", 1),
          "app/[locale]/about/page.tsx": LOCALE_PAGE("about", 2),
          "app/[locale]/docs/intro/page.tsx": LOCALE_PAGE("docs/intro", 3),
          // Only the Flight test requests this source URL: a document request
          // that misses writes the Flight entry too, which would hide a missing seed.
          "app/[locale]/contact/page.tsx": LOCALE_PAGE("contact", 2),
          "app/[locale]/shop/page.tsx": LOCALE_PAGE("shop", 2),
          "app/[locale]/legacy/page.tsx": LOCALE_PAGE("legacy", 2),
          // `/hook` is a rewrite source of this page by its pattern, but a
          // route handler owns that URL. The handler records each call.
          "app/[locale]/hook/page.tsx": LOCALE_PAGE("hook", 2),
          "app/hook/route.ts": `import fs from "node:fs";

export function GET() {
  fs.appendFileSync(process.env.VINEXT_TEST_CALL_LOG, "GET /hook\\n");
  return new Response("hook route handler");
}
`,
          // The runtime gives a rewritten page the percent-encoded form of a
          // captured param, so the title lookup accepts both forms.
          "app/[locale]/blog/[slug]/page.tsx": `const TITLES: Record<string, string> = {
  "café": "coffee",
  "caf%C3%A9": "coffee",
  "with space": "spaced",
  "with%20space": "spaced",
};

export function generateStaticParams() {
  return [
    { locale: "en", slug: "café" },
    { locale: "en", slug: "with space" },
  ];
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <main><p>{\`page:blog:\${TITLES[slug]}\`}</p></main>;
}
`,
        },
      ));
      callsDuringBuild = callLog.read();
      ({ server, baseUrl } = await startServer(root));
    }, 180_000);

    afterAll(async () => {
      await stop(server, root);
      callLog?.remove();
    });

    it("does not run a route handler that owns a rewrite source URL during the build", async () => {
      expect(callsDuringBuild).toBe("");

      const response = await fetch(url("/hook"));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("hook route handler");
    });

    it("serves the prerendered destination URL as a cache hit", async () => {
      const response = await fetch(url("/en/about"));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-vinext-cache")).toBe("HIT");
      const html = await response.text();
      expect(html).toContain("page:about:en");
      expect(html).toContain("pathname:/en/about");
    });

    it.each([
      ["/", "page:home:en"],
      ["/about", "page:about:en"],
      // The source parameter captures more than one path segment.
      ["/docs/intro", "page:docs/intro:en"],
      // The rewritten pathname has a trailing slash that the page URL does not have.
      ["/shop", "page:shop:en"],
    ])("serves the rewritten source URL %s as a cache hit", async (sourcePath, marker) => {
      const response = await fetch(url(sourcePath));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-vinext-cache")).toBe("HIT");
      const html = await response.text();
      expect(html).toContain(marker);
      // The entry must be the render of the source URL, not a copy of the
      // destination entry: usePathname() reports the URL in the address bar.
      expect(html).toContain(`pathname:${sourcePath}`);
      expect(html).not.toContain("pathname:/en");
    });

    // The request handler keeps the percent-encoding of the request in the
    // resolved part of the cache pathname.
    it.each([
      ["/blog/caf%C3%A9", "page:blog:coffee"],
      ["/blog/with%20space", "page:blog:spaced"],
    ])("serves the percent-encoded source URL %s as a cache hit", async (sourcePath, marker) => {
      const response = await fetch(url(sourcePath));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-vinext-cache")).toBe("HIT");
      expect(await response.text()).toContain(marker);
    });

    it("serves a source URL below /api, which never gets a trailing slash, as a cache hit", async () => {
      const response = await fetch(`${baseUrl}${basePath}/api/info`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-vinext-cache")).toBe("HIT");
      expect(await response.text()).toContain("page:about:en");
    });

    it("serves the rewritten source URL Flight payload as a cache hit", async () => {
      const response = await fetch(url("/contact"), {
        headers: { Accept: "text/x-component", RSC: "1" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-vinext-cache")).toBe("HIT");
      expect(await response.text()).toContain("page:contact:en");
    });

    it("does not seed a source URL with the render of a page that another rule selects", async () => {
      // The build request for `/promo` resolves to `/en/about`, through a rule
      // that the build does not invert. The build must not record that render
      // as the entry of `/en/contact`, which the other `/promo` rule names.
      expect(routes.filter((route) => route.rewrite?.source === "/promo")).toEqual([]);

      const response = await fetch(url("/promo"), { headers: { Cookie: "seen=1" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-vinext-cache")).toBe("MISS");
      const html = await response.text();
      expect(html).toContain("page:contact:en");
      expect(html).not.toContain("page:about:en");
    });

    it("does not report a prerender error for a source URL that does not render", () => {
      // `/legacy` is a rewrite source of `/en/legacy`, but a redirect takes it.
      expect(routes.filter((route) => route.rewrite?.source === "/legacy")).toEqual([]);
      expect(routes.filter((route) => route.status === "error")).toEqual([]);
    });

    it("does not register the rewritten source URL as a prerendered path of the route", () => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, "dist/server/vinext-prerender.json"), "utf8"),
      ) as { pregeneratedConcretePaths: Array<[string, string[]]> };
      const paths = new Map(manifest.pregeneratedConcretePaths).get("/:locale/about");
      expect([...(paths ?? [])].sort()).toEqual(["/en/about", "/es/about"]);
    });
  },
);

describe("next.config rewrites with the redirect that removes the default locale prefix", () => {
  let root = "";
  let server: Server | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    ({ root } = await buildFixture(
      `export default {
  async redirects() {
    return [{ source: "/en/:path*", destination: "/:path*", permanent: true }];
  },
  async rewrites() {
    return {
      afterFiles: [${UNPREFIXED_DEFAULT_LOCALE_RULES}
      ],
    };
  },
};
`,
      { "app/[locale]/about/page.tsx": LOCALE_PAGE("about", 2) },
    ));
    ({ server, baseUrl } = await startServer(root));
  }, 180_000);

  afterAll(() => stop(server, root));

  it("serves the source URL as a cache hit although the page URL redirects", async () => {
    // The build request for `/en/about` gets the redirect, so that URL has no
    // prerender artifact. The source URL is the only URL that reaches the page.
    const destination = await fetch(`${baseUrl}/en/about`, { redirect: "manual" });
    expect(destination.status).toBe(308);

    const source = await fetch(`${baseUrl}/about`);
    expect(source.status).toBe(200);
    expect(source.headers.get("x-vinext-cache")).toBe("HIT");
    expect(await source.text()).toContain("page:about:en");
  });
});

describe("next.config rewrite sources that differ only by letter case", () => {
  let root = "";
  let routes: ManifestRoute[] = [];
  let server: Server | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    ({ root, routes } = await buildFixture(
      `export default {
  async rewrites() {
    return {
      afterFiles: [
        { source: "/About", destination: "/en/about" },
        { source: "/about", destination: "/en/about" },
      ],
    };
  },
};
`,
      { "app/[locale]/about/page.tsx": LOCALE_PAGE("about", 2) },
    ));
    ({ server, baseUrl } = await startServer(root));
  }, 180_000);

  afterAll(() => stop(server, root));

  it("seeds one of them, so their artifact files cannot overwrite each other", async () => {
    // On a file system that ignores letter case, `About.html` and `about.html`
    // are one file. Each URL must still get the render of its own pathname.
    expect(routes.flatMap((route) => route.rewrite?.source ?? [])).toEqual(["/About"]);

    const seeded = await fetch(`${baseUrl}/About`);
    expect(seeded.headers.get("x-vinext-cache")).toBe("HIT");
    expect(await seeded.text()).toContain("pathname:/About");

    const rendered = await fetch(`${baseUrl}/about`);
    expect(rendered.headers.get("x-vinext-cache")).toBe("MISS");
    expect(await rendered.text()).toContain("pathname:/about");
  });
});

describe("a Pages Router route that owns a rewrite source URL in a hybrid build", () => {
  let root = "";
  let routes: ManifestRoute[] = [];
  let server: Server | undefined;
  let baseUrl = "";
  let callLog: ReturnType<typeof createCallLog> | undefined;
  let callsDuringBuild = "";

  beforeAll(async () => {
    callLog = createCallLog();
    ({ root, routes } = await buildFixture(
      `export default {
  async rewrites() {
    return {
      afterFiles: [${UNPREFIXED_DEFAULT_LOCALE_RULES}
      ],
    };
  },
};
`,
      {
        "app/[locale]/about/page.tsx": LOCALE_PAGE("about", 2),
        "app/[locale]/feed/page.tsx": LOCALE_PAGE("feed", 2),
        "pages/feed.tsx": `import fs from "node:fs";

export function getServerSideProps() {
  fs.appendFileSync(process.env.VINEXT_TEST_CALL_LOG, "getServerSideProps /feed\\n");
  return { props: {} };
}

export default function Feed() {
  return <p>pages feed</p>;
}
`,
      },
    ));
    callsDuringBuild = callLog.read();
    ({ server, baseUrl } = await startServer(root));
  }, 180_000);

  afterAll(async () => {
    await stop(server, root);
    callLog?.remove();
  });

  it("does not run during the build", async () => {
    // `/feed` is a rewrite source of `/en/feed` by its pattern. The prerender
    // does not render a page that has getServerSideProps.
    expect(callsDuringBuild).toBe("");

    const response = await fetch(`${baseUrl}/feed`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("pages feed");
  });

  // In a hybrid build, the prerender sends its requests to a server over HTTP.
  it("does not stop the seeding of a source URL that no Pages route owns", async () => {
    expect(routes.flatMap((route) => route.rewrite?.source ?? [])).toEqual(["/about"]);

    const response = await fetch(`${baseUrl}/about`);
    expect(response.headers.get("x-vinext-cache")).toBe("HIT");
    const html = await response.text();
    expect(html).toContain("page:about:en");
    expect(html).toContain("pathname:/about");
  });
});

describe("a rewrite source URL that the request handler resolves to another owner", () => {
  let root = "";
  let routes: ManifestRoute[] = [];
  let server: Server | undefined;
  let baseUrl = "";
  let callLog: ReturnType<typeof createCallLog> | undefined;
  let callsDuringBuild = "";

  beforeAll(async () => {
    callLog = createCallLog();
    ({ root, routes } = await buildFixture(
      // The config alone does not show the owner of these source URLs:
      // - A request has the percent-encoded spelling of the first source, which
      //   the rule does not match. A dynamic route handler takes the request.
      // - The second rule resolves `/über-uns` to the pathname of a
      //   prerendered page, but the handler matches a route handler for it.
      `export default {
  async rewrites() {
    return {
      afterFiles: [
        { source: "/shop/über-uns", destination: "/about" },
        { source: "/:path((?!en$|en/|shop/|about$|_next/).*)", destination: "/en/:path" },
      ],
    };
  },
};
`,
      {
        "app/about/page.tsx": `export default function Page() {
  return <p>about</p>;
}
`,
        "app/[locale]/[slug]/page.tsx": `export function generateStaticParams() {
  return [{ locale: "en", slug: "über-uns" }];
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <p>{(await params).slug}</p>;
}
`,
        "app/[locale]/über-uns/route.ts": `import fs from "node:fs";

export async function GET() {
  fs.appendFileSync(process.env.VINEXT_TEST_CALL_LOG, "GET /[locale]/über-uns\\n");
  return new Response("locale route handler");
}
`,
        "app/shop/[item]/route.ts": `import fs from "node:fs";

export async function GET() {
  fs.appendFileSync(process.env.VINEXT_TEST_CALL_LOG, "GET /shop/[item]\\n");
  return new Response("shop route handler");
}
`,
      },
    ));
    callsDuringBuild = callLog.read();
    ({ server, baseUrl } = await startServer(root));
  }, 180_000);

  afterAll(async () => {
    await stop(server, root);
    callLog?.remove();
  });

  it("does not run that owner during the build, and seeds nothing for the URL", async () => {
    expect(callsDuringBuild).toBe("");
    expect(routes.filter((route) => route.rewrite)).toEqual([]);

    const response = await fetch(`${baseUrl}/shop/${encodeURIComponent("über-uns")}`);
    expect(await response.text()).toBe("shop route handler");
  });
});

describe("static export with next.config rewrites", () => {
  it("does not write rewrite source artifacts into the public export directory", async () => {
    const { root, routes } = await buildFixture(
      `export default {
  output: "export",
  async rewrites() {
    return { afterFiles: [{ source: "/about", destination: "/en/about" }] };
  },
};
`,
      { "app/[locale]/about/page.tsx": LOCALE_PAGE("about", 2) },
    );
    try {
      const exportDir = path.join(root, "dist/client");
      expect(fs.existsSync(path.join(exportDir, "en/about.html"))).toBe(true);
      expect(fs.existsSync(path.join(exportDir, "__vinext"))).toBe(false);
      expect(routes.filter((route) => route.rewrite)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
