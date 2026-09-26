import { describe, expect, it } from "vite-plus/test";
import { resolveAppPageHead } from "../packages/vinext/src/server/app-page-head.js";
import {
  renderMetadataToHtml,
  resolveModuleMetadata,
  type Metadata,
} from "../packages/vinext/src/shims/metadata.js";

// Ported from Next.js: test/e2e/app-dir/metadata/metadata.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/metadata/metadata.test.ts
describe("generateMetadata parent values", () => {
  it("exposes template-only layout titles without changing the rendered page title", async () => {
    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [{ metadata: { title: { template: "%s | Acme" } } }],
      metadataRoutes: [],
      pageModule: {
        async generateMetadata(_props: unknown, resolving: Promise<Metadata>) {
          const parent = await resolving;
          expect(parent.title).toEqual({ absolute: "", template: "%s | Acme" });
          return { title: "Article" };
        },
      },
      params: {},
      routePath: "/article",
      routeSegments: ["article"],
    });
    expect(result.metadata?.title).toBe("Article | Acme");
    expect(renderMetadataToHtml(result.metadata!)).toContain("<title>Article | Acme</title>");
  });

  it("normalizes a direct template-only parent title with an empty absolute", async () => {
    await resolveModuleMetadata(
      {
        async generateMetadata(_props: unknown, resolving: Promise<Metadata>) {
          expect((await resolving).title).toEqual({ absolute: "", template: "%s | Acme" });
          return {};
        },
      },
      {},
      undefined,
      Promise.resolve({ title: { template: "%s | Acme" } }),
    );
  });

  it("exposes a plain leaf title without its ancestor template while rendering the page", async () => {
    let parentTitle: unknown;
    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [
        { metadata: { title: { default: "Acme", template: "%s | Acme" } } },
        { metadata: { title: "Section" } },
      ],
      layoutTreePositions: [0, 1],
      metadataRoutes: [],
      pageModule: {
        async generateMetadata(_props: unknown, resolving: Promise<{ title: unknown }>) {
          parentTitle = (await resolving).title;
          return { title: "Article" };
        },
      },
      params: {},
      routePath: "/section",
      routeSegments: ["section"],
    });
    expect(parentTitle).toEqual({ absolute: "Section | Acme", template: null });
    expect(result.metadata?.title).toBe("Article | Acme");
  });

  it("supplies keyword arrays and string URLs to child resolvers", async () => {
    const result = await resolveModuleMetadata(
      {
        async generateMetadata(
          _props: unknown,
          parent: Promise<{ keywords: string[]; metadataBase: string }>,
        ) {
          const metadata = await parent;
          return {
            keywords: metadata.keywords.concat(["child"]),
            metadataBase: metadata.metadataBase.replace("base", "case"),
          };
        },
      },
      {},
      undefined,
      Promise.resolve({ keywords: "parent", metadataBase: new URL("https://example.com/base") }),
    );
    expect(result).toEqual({
      keywords: ["parent", "child"],
      metadataBase: "https://example.com/case",
    });
  });

  it("clones normalized parent arrays without mutating ancestor metadata", async () => {
    const parent = {
      keywords: ["parent"],
      authors: { name: "Author", url: "https://example.com/author" },
    };
    const result = await resolveModuleMetadata(
      {
        async generateMetadata(
          _props: unknown,
          resolving: Promise<{
            keywords: string[];
            authors: unknown[];
          }>,
        ) {
          const metadata = await resolving;
          expect(metadata.authors).toEqual([parent.authors]);

          metadata.keywords.push("child");
          return { keywords: metadata.keywords };
        },
      },
      {},
      undefined,
      Promise.resolve(parent),
    );
    expect(result?.keywords).toEqual(["parent", "child"]);
    expect(parent.keywords).toEqual(["parent"]);
  });

  it("supplies resolved title and robots values to child resolvers", async () => {
    const result = await resolveModuleMetadata(
      {
        async generateMetadata(
          _props: unknown,
          resolving: Promise<{ title: { absolute: string }; robots: { basic: string } }>,
        ) {
          const parent = await resolving;
          return {
            title: `${parent.title.absolute} child`,
            description: parent.robots.basic,
            robots: parent.robots,
          };
        },
      },
      {},
      undefined,
      Promise.resolve({ title: "Parent", robots: { index: false, follow: true } }),
    );
    expect(result).toMatchObject({ title: "Parent child", description: "noindex, follow" });
    expect(renderMetadataToHtml(result!)).toContain('name="robots" content="noindex, follow"');
  });

  it("treats empty robots as null in the resolved parent", async () => {
    const result = await resolveModuleMetadata(
      {
        async generateMetadata(_props: unknown, resolving: Promise<Metadata>) {
          const { robots } = await resolving;
          expect(robots).toBeNull();
          return { robots };
        },
      },
      {},
      undefined,
      Promise.resolve({ robots: "" }),
    );
    expect(renderMetadataToHtml(result!)).not.toContain('name="robots"');
  });

  it("exposes robots directives in Next.js order regardless of input order", async () => {
    const result = await resolveModuleMetadata(
      {
        async generateMetadata(_props: unknown, resolving: Promise<Metadata>) {
          const { robots } = await resolving;
          expect(robots).toEqual({
            basic: "index, nofollow, noarchive, nosnippet",
            googleBot: "index, nofollow, noarchive, max-snippet:0",
          });
          return { robots };
        },
      },
      {},
      undefined,
      Promise.resolve({
        robots: {
          noarchive: true,
          follow: false,
          nosnippet: true,
          index: true,
          googleBot: { "max-snippet": 0, noarchive: true, follow: false, index: true },
        },
      }),
    );
    const html = renderMetadataToHtml(result!);
    expect(html).toContain('name="robots" content="index, nofollow, noarchive, nosnippet"');
    expect(html).toContain('name="googlebot" content="index, nofollow, noarchive, max-snippet:0"');
  });

  it("observes a derived parent rejection when a child ignores its parent", async () => {
    let rejectParent!: (error: Error) => void;
    const parent = new Promise<Metadata>((_resolve, reject) => {
      rejectParent = reject;
    });
    void parent.catch(() => null);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = await resolveModuleMetadata(
        {
          async generateMetadata(_props: unknown, _resolving: Promise<Metadata>) {
            return { description: "child" };
          },
        },
        {},
        undefined,
        parent,
      );
      expect(result?.description).toBe("child");
      rejectParent(new Error("ancestor failed"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("omits false robots directives other than index and follow from parent and HTML", async () => {
    const result = await resolveModuleMetadata(
      {
        async generateMetadata(_props: unknown, resolving: Promise<Metadata>) {
          const { robots } = await resolving;
          expect(robots).toEqual({
            basic: "noindex, nofollow, max-snippet:0",
            googleBot: "noindex, follow, max-video-preview:0",
          });
          return { robots };
        },
      },
      {},
      undefined,
      Promise.resolve({
        robots: {
          index: false,
          follow: false,
          noarchive: false,
          nosnippet: false,
          "max-snippet": 0,
          googleBot: {
            index: false,
            follow: true,
            noimageindex: false,
            "max-video-preview": 0,
          },
        },
      }),
    );
    const html = renderMetadataToHtml(result!);
    expect(html).toContain('name="robots" content="noindex, nofollow, max-snippet:0"');
    expect(html).toContain('name="googlebot" content="noindex, follow, max-video-preview:0"');
    expect(html).not.toContain("nonoarchive");
  });

  it("does not let child mutations change nested ancestor metadata", async () => {
    const parent = {
      authors: [{ name: "Original" }],
      openGraph: { images: [{ url: new URL("https://example.com/og.png") }] },
    };
    await resolveModuleMetadata(
      {
        async generateMetadata(
          _props: unknown,
          resolving: Promise<{
            authors: Array<{ name: string }>;
            openGraph: { images: Array<{ url: string | URL }> };
          }>,
        ) {
          const metadata = await resolving;
          metadata.authors[0].name = "Changed";
          metadata.openGraph.images[0].url = "https://example.com/other.png";
          return {};
        },
      },
      {},
      undefined,
      Promise.resolve(parent),
    );
    expect(parent.authors[0].name).toBe("Original");
    expect(parent.openGraph.images[0].url.toString()).toBe("https://example.com/og.png");
  });

  it("converts URL values nested in the resolved parent without mutating the source", async () => {
    const parent = {
      authors: [{ url: new URL("https://example.com/author") }],
      openGraph: { images: [{ url: new URL("https://example.com/og.png") }] },
      icons: { icon: [{ url: new URL("https://example.com/icon.ico") }] },
      appLinks: { ios: [{ url: new URL("https://example.com/app") }] },
    };
    await resolveModuleMetadata(
      {
        async generateMetadata(
          _props: unknown,
          resolving: Promise<{
            authors: Array<{ url: string }>;
            openGraph: { images: Array<{ url: string }> };
            icons: { icon: Array<{ url: string }> };
            appLinks: { ios: Array<{ url: string }> };
          }>,
        ) {
          const metadata = await resolving;
          expect(metadata.authors[0].url.replace("author", "writer")).toBe(
            "https://example.com/writer",
          );
          expect(metadata.openGraph.images[0].url.replace("og", "image")).toBe(
            "https://example.com/image.png",
          );
          expect(metadata.icons.icon[0].url).toBe("https://example.com/icon.ico");
          expect(metadata.appLinks.ios[0].url).toBe("https://example.com/app");
          return {};
        },
      },
      {},
      undefined,
      Promise.resolve(parent as unknown as Metadata),
    );
    expect(parent.authors[0].url).toBeInstanceOf(URL);
    expect(parent.openGraph.images[0].url).toBeInstanceOf(URL);
  });

  it("exposes scalar App Links as arrays without mutating the ancestor", async () => {
    const parent = {
      appLinks: {
        ios: { url: new URL("https://example.com/app"), app_store_id: "123" },
        android: { package: "com.example.app" },
      },
    };
    await resolveModuleMetadata(
      {
        async generateMetadata(_props: unknown, resolving: Promise<Metadata>) {
          const appLinks = (await resolving).appLinks;
          expect(appLinks?.ios).toEqual([{ url: "https://example.com/app", app_store_id: "123" }]);
          expect(appLinks?.android).toEqual([{ package: "com.example.app" }]);
          return {};
        },
      },
      {},
      undefined,
      Promise.resolve(parent),
    );
    expect(parent.appLinks.ios).not.toBeInstanceOf(Array);
    expect(parent.appLinks.ios.url).toBeInstanceOf(URL);
  });

  it("preserves URL-instance canonical resolution when children spread parent metadata", async () => {
    const result = await resolveModuleMetadata(
      {
        async generateMetadata(_props: unknown, resolving: Promise<Metadata>) {
          return { ...(await resolving) };
        },
      },
      {},
      undefined,
      Promise.resolve({
        alternates: { canonical: { url: new URL("https://other.example/root?ref=source") } },
      }),
      undefined,
      "/article",
    );
    expect(renderMetadataToHtml(result!, "/article")).toContain(
      'rel="canonical" href="https://other.example/article?ref=source"',
    );
  });

  it("supplies canonical and alternate descriptors for scalar parent URLs", async () => {
    const parent = {
      metadataBase: new URL("https://example.com"),
      alternates: {
        canonical: "./",
        languages: { en: "./en" },
        media: { print: "./print" },
        types: { "application/rss+xml": "./feed" },
      },
    };
    const result = await resolveModuleMetadata(
      {
        async generateMetadata(
          _props: unknown,
          resolving: Promise<{
            alternates: {
              canonical: { url: string };
              languages: { en: Array<{ url: string }> };
              media: { print: Array<{ url: string }> };
              types: { "application/rss+xml": Array<{ url: string }> };
            };
          }>,
        ) {
          const { alternates } = await resolving;
          expect(alternates.canonical).toEqual({ url: "https://example.com/article" });
          expect(alternates.languages.en).toEqual([{ url: "https://example.com/article/en" }]);
          expect(alternates.media.print).toEqual([{ url: "https://example.com/article/print" }]);
          expect(alternates.types["application/rss+xml"]).toEqual([
            { url: "https://example.com/article/feed" },
          ]);
          return { alternates };
        },
      },
      {},
      undefined,
      Promise.resolve(parent),
      undefined,
      "/article",
    );
    expect(renderMetadataToHtml(result!, "/article")).toContain(
      'rel="canonical" href="https://example.com/article"',
    );
    expect(parent.alternates.canonical).toBe("./");
    expect(parent.alternates.languages.en).toBe("./en");
  });

  it("exposes null alternate maps when an ancestor only supplies a canonical URL", async () => {
    await resolveModuleMetadata(
      {
        async generateMetadata(_props: unknown, resolving: Promise<Metadata>) {
          expect((await resolving).alternates).toEqual({
            canonical: { url: "https://example.com/article" },
            languages: null,
            media: null,
            types: null,
          });
          return {};
        },
      },
      {},
      undefined,
      Promise.resolve({
        metadataBase: new URL("https://example.com"),
        alternates: { canonical: "./" },
      }),
      undefined,
      "/article",
    );
  });

  it("keeps the base from the layout that declared inherited alternates", async () => {
    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [
        {
          metadata: {
            metadataBase: new URL("https://root.example"),
            alternates: { canonical: "./", languages: { en: "./en" } },
          },
        },
        { metadata: { metadataBase: new URL("https://nested.example") } },
      ],
      layoutTreePositions: [0, 1],
      metadataRoutes: [],
      pageModule: {
        async generateMetadata(_props: unknown, resolving: Promise<Metadata>) {
          const { alternates } = await resolving;
          expect(alternates?.canonical).toEqual({ url: "https://root.example/article" });
          expect(alternates?.languages?.en).toEqual([{ url: "https://root.example/article/en" }]);
          return { alternates };
        },
      },
      params: {},
      routePath: "/article",
      routeSegments: ["article"],
    });
    expect(renderMetadataToHtml(result.metadata!, "/article")).toContain(
      'rel="canonical" href="https://root.example/article"',
    );
  });

  it("supplies trailingSlash-adjusted alternate URLs to child metadata", async () => {
    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [
        {
          metadata: {
            metadataBase: new URL("https://example.com"),
            alternates: { canonical: "./", languages: { en: "./en" } },
          },
        },
      ],
      metadataRoutes: [],
      pageModule: {
        async generateMetadata(_props: unknown, resolving: Promise<Metadata>) {
          const { alternates } = await resolving;
          expect(alternates?.canonical).toEqual({ url: "https://example.com/article/" });
          expect(alternates?.languages?.en).toEqual([{ url: "https://example.com/article/en/" }]);
          return { alternates };
        },
      },
      params: {},
      routePath: "/article",
      trailingSlash: true,
    });
    expect(renderMetadataToHtml(result.metadata!, "/article", { trailingSlash: true })).toContain(
      'rel="canonical" href="https://example.com/article/"',
    );
  });

  it("resolves a title map key as a URL but preserves descriptor titles", async () => {
    await resolveModuleMetadata(
      {
        async generateMetadata(_props: unknown, resolving: Promise<Metadata>) {
          const { alternates } = await resolving;
          expect(alternates?.media?.title).toEqual([{ url: "https://example.com/article/print" }]);
          expect(alternates?.media?.print).toEqual([
            { url: "https://example.com/article/print", title: "Print" },
          ]);
          return {};
        },
      },
      {},
      undefined,
      Promise.resolve({
        metadataBase: new URL("https://example.com"),
        alternates: {
          media: { title: "./print", print: [{ url: "./print", title: "Print" }] },
        },
      }),
      undefined,
      "/article",
    );
  });

  it("omits null and empty alternate entries from the resolved parent", async () => {
    const parent: Metadata = {
      metadataBase: new URL("https://example.com"),
      alternates: {
        languages: { en: null, fr: [], de: "./de" },
        media: { print: null, screen: "./screen" },
        types: {
          "application/rss+xml": [],
          "application/json": [{ url: "./feed", title: "Feed" }],
        },
      },
    };
    const result = await resolveModuleMetadata(
      {
        async generateMetadata(_props: unknown, resolving: Promise<Metadata>) {
          const { alternates } = await resolving;
          expect(alternates?.languages).toEqual({
            de: [{ url: "https://example.com/article/de" }],
          });
          expect(alternates?.media).toEqual({
            screen: [{ url: "https://example.com/article/screen" }],
          });
          expect(alternates?.types).toEqual({
            "application/json": [{ url: "https://example.com/article/feed", title: "Feed" }],
          });
          return { alternates };
        },
      },
      {},
      undefined,
      Promise.resolve(parent),
      undefined,
      "/article",
    );
    const html = renderMetadataToHtml(result!, "/article");
    expect(html).toContain('hreflang="de"');
    expect(html).toContain('media="screen"');
    expect(html).toContain('type="application/json"');
    expect(html).not.toContain('hreflang="en"');
    expect(parent.alternates?.languages?.en).toBeNull();
  });

  it("drops canonical titles while keeping titles on alternate descriptor arrays", async () => {
    await resolveModuleMetadata(
      {
        async generateMetadata(_props: unknown, resolving: Promise<Metadata>) {
          const alternates = (await resolving).alternates;
          expect(alternates?.canonical).toEqual({ url: "https://example.com/article" });
          expect(alternates?.languages?.en).toEqual([
            { url: "https://example.com/article/en", title: "English" },
          ]);
          expect(alternates?.media?.print).toEqual([
            { url: "https://example.com/article/print", title: "Print" },
          ]);
          expect(alternates?.types?.["application/rss+xml"]).toEqual([
            { url: "https://example.com/article/feed", title: "Feed" },
          ]);
          return {};
        },
      },
      {},
      undefined,
      Promise.resolve({
        metadataBase: new URL("https://example.com"),
        alternates: {
          canonical: { url: "./", title: "Ignored" },
          languages: { en: [{ url: "./en", title: "English" }] },
          media: { print: [{ url: "./print", title: "Print" }] },
          types: { "application/rss+xml": [{ url: "./feed", title: "Feed" }] },
        },
      }),
      undefined,
      "/article",
    );
  });
});
