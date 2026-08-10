/**
 * End-to-end plugin wiring for `images.loaderFile`.
 *
 * The codegen and config-resolution units are covered in
 * `image-loader-config.test.ts`. This file checks the parts those cannot:
 *
 *  - that the vinext plugin actually resolves and loads
 *    `virtual:vinext-image-loader` from a real next.config, which is the step
 *    that was missing entirely and made the option look unsupported;
 *  - what the `next/image` shim then *does* with a configured loader.
 *
 * The second group has to run here rather than as a unit test. The shim imports
 * the virtual module statically and unit tests alias it to the unconfigured
 * stand-in (`image/image-loader-unconfigured.ts`), so the configured branches
 * are only reachable by letting the plugin generate the module for real.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { startFixtureServer, fetchHtml } from "./helpers.js";

/** Root layout — the app router refuses to render a page without one. */
const ROOT_LAYOUT = `export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;

/**
 * Renders one `<pre>` per `getImageProps` case, so each outcome — including a
 * thrown misconfiguration — arrives as text in the SSR HTML.
 *
 * It is a *client* page for two reasons. `next/image` is a `"use client"`
 * module, so its exports are client references in the RSC environment and
 * calling `getImageProps` from a page or route handler fails outright. And the
 * `loader` prop is a function, which cannot cross the server/client boundary —
 * declared here, it never has to.
 */
const PROBE_PAGE = `"use client";

import { getImageProps } from "next/image";

const loaderProp = ({ src, width }) => \`https://prop.example.com\${src}?w=\${width}\`;

// A 1x1 GIF. Inline bytes: no loader can turn this into a fetchable CDN URL.
const DATA_URI =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function probe(id, props) {
  let text;
  try {
    const { props: imgProps } = getImageProps(props);
    text = \`OK \${imgProps.src} | \${imgProps.srcSet ?? "none"}\`;
  } catch (error) {
    text = \`ERROR \${error.message}\`;
  }
  return <pre id={id}>{text}</pre>;
}

export default function Page() {
  const base = { alt: "probe", src: "/photo.jpg", width: 300, height: 200 };
  return (
    <main>
      {probe("plain", base)}
      {probe("unoptimized", { ...base, unoptimized: true })}
      {probe("loader-prop", { ...base, loader: loaderProp })}
      {probe("loader-prop-unoptimized", { ...base, loader: loaderProp, unoptimized: true })}
      {probe("data-uri", { ...base, src: DATA_URI })}
      {probe("blob-uri", { ...base, src: "blob:https://example.com/abc-123" })}
    </main>
  );
}
`;

/** Read one probe's rendered text back out of the SSR HTML. */
function probeText(html: string, id: string): string {
  const match = new RegExp(`<pre id="${id}"[^>]*>([\\s\\S]*?)</pre>`).exec(html);
  if (!match) throw new Error(`probe "${id}" not found in rendered HTML`);
  return match[1]
    .replace(/<!-- -->/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Build a throwaway project root with an app dir, a loader file, and the given
 * next.config body. `node_modules` is symlinked so plugin-internal resolution
 * behaves as it would in a real project.
 */
function createProject(nextConfigBody: string, extraFiles: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-loaderfile-plugin-"));
  fs.mkdirSync(path.join(root, "app"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "app", "page.tsx"),
    "export default function Page() { return null; }\n",
  );
  // `quality ?? "auto"` rather than `?? 75`: it makes an omitted quality
  // visible in the URL, so a forced default at the loader seam cannot hide
  // behind producing the same 75 the built-in optimizer would have used.
  fs.writeFileSync(
    path.join(root, "my-loader.js"),
    "export default ({ src, width, quality }) =>\n" +
      '  `https://images.example.com${src}?width=${width}&quality=${quality ?? "auto"}`;\n',
  );
  fs.writeFileSync(path.join(root, "next.config.mjs"), nextConfigBody);
  for (const [relativePath, contents] of Object.entries(extraFiles)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "..", "node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  return root;
}

/** Resolve + load `virtual:vinext-image-loader` through the real plugin. */
async function loadVirtualLoaderModule(root: string): Promise<string> {
  const { server } = await startFixtureServer(root, { listen: false });
  try {
    const resolved = await server.pluginContainer.resolveId("virtual:vinext-image-loader");
    expect(resolved).toBeTruthy();
    const loaded = await server.pluginContainer.load(resolved!.id);
    return typeof loaded === "string" ? loaded : ((loaded as { code?: string } | null)?.code ?? "");
  } finally {
    await server.close();
  }
}

describe("virtual:vinext-image-loader plugin wiring", () => {
  it("loads the configured loaderFile from next.config", async () => {
    const root = createProject(
      "export default { images: { loader: 'custom', loaderFile: './my-loader.js' } };\n",
    );
    const code = await loadVirtualLoaderModule(root);

    // The generator receives an already-absolute path from resolveNextConfig.
    expect(code).toContain("my-loader.js");
    expect(code).toContain("export default __vinextImageLoader;");
    expect(code).not.toContain("export default undefined;");
  });

  it("falls back to the built-in loader when no loaderFile is set", async () => {
    const root = createProject("export default { images: { unoptimized: false } };\n");
    const code = await loadVirtualLoaderModule(root);

    expect(code).toContain("export default undefined;");
  });
});

// ─── the shim, driven by a real generated loader ───────────────────────────

describe("next/image with images.loaderFile configured", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    const root = createProject(
      "export default { images: { loader: 'custom', loaderFile: './my-loader.js' } };\n",
      {
        "app/layout.tsx": ROOT_LAYOUT,
        "app/probe/page.tsx": PROBE_PAGE,
        // `blurDataURL` is required alongside placeholder="blur"; the value is
        // opaque to the shim beyond its sanitization check.
        "app/images/page.tsx": `import Image from "next/image";

export default function Page() {
  return (
    <main>
      <Image alt="local" src="/photo.jpg" width={300} height={200} />
      <Image alt="remote" src="https://origin.example.com/photo.jpg" width={300} height={200} />
      <Image
        alt="blurred"
        src="/blurred.jpg"
        width={300}
        height={200}
        placeholder="blur"
        blurDataURL="data:image/png;base64,abc123"
      />
    </main>
  );
}
`,
      },
    );
    ({ server, baseUrl } = await startFixtureServer(root));
    await fetch(`${baseUrl}/images`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("replaces the built-in loader for local and remote sources alike", async () => {
    const { html } = await fetchHtml(baseUrl, "/images");

    expect(html).toContain("https://images.example.com/photo.jpg?width=");
    // The configured loader owns remote sources too, matching upstream, where
    // loaderFile replaces the default loader for every image. No separator
    // before the remote src: my-loader.js concatenates, and a remote source has
    // no leading slash — the loader owns the URL, warts and all.
    expect(html).toContain("https://images.example.comhttps://origin.example.com/photo.jpg");
    expect(html).not.toContain("/_next/image");
  });

  it("keeps the blur placeholder", async () => {
    // The regression this guards: selecting a configured loader dropped into a
    // branch that ignored placeholder="blur", so an image that showed a
    // placeholder under the built-in loader silently lost it.
    const { html } = await fetchHtml(baseUrl, "/images");

    expect(html).toContain("data:image/png;base64,abc123");
    expect(html).toContain("background-image");
  });

  it("leaves an omitted quality to the loader instead of forcing 75", async () => {
    // A configured loader must be able to tell "no quality requested" from
    // "quality 75", which is what lets it pick an automatic CDN quality.
    // `&amp;` because the query separator is HTML-escaped in the attribute.
    const { html } = await fetchHtml(baseUrl, "/images");

    expect(html).toContain("&amp;quality=auto");
    expect(html).not.toContain("&amp;quality=75");
  });

  it("is overridden by a per-image loader prop", async () => {
    const { html } = await fetchHtml(baseUrl, "/probe");

    expect(probeText(html, "loader-prop")).toContain("OK https://prop.example.com/photo.jpg");
  });

  it("leaves data: and blob: sources untouched", async () => {
    // Upstream forces these to `unoptimized` before any loader runs
    // (`get-img-props.ts:270`). Without that guard a configured loaderFile
    // rewrites the inline bytes into `https://images.example.com/data:image/...`
    // — a CDN request for a path that cannot exist — and emits a srcSet of
    // them. Asserting the exact string, not just the absence of the CDN host,
    // so a future change that merely mangles the URI differently still fails.
    const { html } = await fetchHtml(baseUrl, "/probe");

    expect(probeText(html, "data-uri")).toBe(
      "OK data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7 | none",
    );
    expect(probeText(html, "blob-uri")).toBe("OK blob:https://example.com/abc-123 | none");
  });
});

describe('next/image with images.loader "custom" and no loaderFile', () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    const root = createProject("export default { images: { loader: 'custom' } };\n", {
      "app/layout.tsx": ROOT_LAYOUT,
      "app/probe/page.tsx": PROBE_PAGE,
    });
    ({ server, baseUrl } = await startFixtureServer(root));
    await fetch(`${baseUrl}/probe`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("reports the missing loader prop", async () => {
    const { html } = await fetchHtml(baseUrl, "/probe");

    expect(probeText(html, "plain")).toContain(
      'ERROR Image with src "/photo.jpg" is missing "loader" prop.',
    );
  });

  it("reports it for unoptimized images too", async () => {
    // Upstream raises this before it decides whether an image is optimized
    // (`getImgProps` throws above `generateImgAttrs`, which is what handles
    // `unoptimized`). Skipping it would let `unoptimized` silently render the
    // original URL from a config that cannot produce URLs at all.
    const { html } = await fetchHtml(baseUrl, "/probe");

    expect(probeText(html, "unoptimized")).toContain('is missing "loader" prop.');
  });

  it("is satisfied by a per-image loader prop", async () => {
    const { html } = await fetchHtml(baseUrl, "/probe");

    expect(probeText(html, "loader-prop")).toContain("OK https://prop.example.com/photo.jpg");
  });

  it("still bypasses a valid loader prop for unoptimized images", async () => {
    // The unoptimized shortcut is withheld only from the misconfiguration
    // report — a working loader is still skipped, as upstream does.
    const { html } = await fetchHtml(baseUrl, "/probe");

    expect(probeText(html, "loader-prop-unoptimized")).toBe("OK /photo.jpg | none");
  });
});
