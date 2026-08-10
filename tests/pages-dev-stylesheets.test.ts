import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createServer, type ViteDevServer } from "vite-plus";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toSlash } from "pathslash";
import {
  collectPagesDevInitialStylesheetHeadHTML,
  isViteInjectedStylesheetModule,
  isViteStylesheetGraphTraversalBoundary,
  resolvePagesDevStylesheetId,
} from "../packages/vinext/src/server/pages-dev-stylesheets.js";

describe("Pages dev stylesheet discovery", () => {
  it("only adopts CSS requests whose Vite transform calls updateStyle", () => {
    for (const url of [
      "/style.css",
      "/style.module.scss?theme=dark",
      "/style.sass?theme=raw",
      "/style.css?redirect=false",
      "/style.css?RAW",
    ]) {
      expect(isViteInjectedStylesheetModule({ type: "css", url }), url).toBe(true);
    }

    for (const query of ["raw", "url", "worker", "sharedworker", "inline", "direct"]) {
      expect(
        isViteInjectedStylesheetModule({ type: "css", url: `/style.css?${query}` }),
        query,
      ).toBe(false);
      expect(
        isViteInjectedStylesheetModule({
          type: "css",
          url: `/style.css?theme=dark&${query}=false`,
        }),
        `${query}=false`,
      ).toBe(false);
    }

    expect(isViteInjectedStylesheetModule({ type: "js", url: "/not-css.js" })).toBe(false);
  });

  it("traverses executable JavaScript query wrappers", () => {
    for (const query of ["inline", "direct"]) {
      expect(isViteStylesheetGraphTraversalBoundary({ url: `/component.js?${query}` }), query).toBe(
        false,
      );
      expect(
        isViteStylesheetGraphTraversalBoundary({ url: `/style.css?${query}` }),
        `css?${query}`,
      ).toBe(true);
    }

    for (const query of ["raw", "url", "worker", "sharedworker"]) {
      expect(isViteStylesheetGraphTraversalBoundary({ url: `/component.js?${query}` }), query).toBe(
        true,
      );
      expect(
        isViteStylesheetGraphTraversalBoundary({ url: `/component.js?${query}=false` }),
        `${query}=false`,
      ).toBe(false);
    }
  });
});

describe("Pages dev stylesheet Vite ids", () => {
  let root: string;
  let server: ViteDevServer;
  let stylesheetPath: string;

  beforeAll(async () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-dev-css-id-")));
    stylesheetPath = path.join(root, "style sheet.css");
    fs.writeFileSync(stylesheetPath, ".target { color: green; }\n");
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: { port: 0 },
      plugins: [
        {
          name: "test:stylesheet-id",
          resolveId(id) {
            if (id === "virtual:safe-style.css") return "virtual:safe-style.css?resolved";
            if (id.startsWith("virtual:safe-style.css?resolved")) return id;
            if (id === "virtual:null-style.css") return "\0virtual:null-style.css";
          },
          load(id) {
            if (id.startsWith("virtual:safe-style.css?resolved")) {
              return ".safe-virtual { color: green; }\n";
            }
          },
        },
      ],
    });
    await server.listen();
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("collects CSS imported through an executable JavaScript query wrapper", async () => {
    const entryPath = path.join(root, "queried-entry.js");
    fs.writeFileSync(
      entryPath,
      'import "./inline-wrapper.js?inline";\nimport "./raw-value-wrapper.js?raw=false";\n',
    );
    fs.writeFileSync(path.join(root, "inline-wrapper.js"), 'import "./inline-wrapper.css";\n');
    fs.writeFileSync(
      path.join(root, "raw-value-wrapper.js"),
      'import "./raw-value-wrapper.css";\n',
    );
    fs.writeFileSync(path.join(root, "inline-wrapper.css"), ".inline { color: green; }\n");
    fs.writeFileSync(path.join(root, "raw-value-wrapper.css"), ".raw-value { color: blue; }\n");

    const html = await collectPagesDevInitialStylesheetHeadHTML(
      server,
      {
        async import() {
          throw new Error("No Pages manifest in this focused Vite fixture");
        },
      },
      [entryPath],
      "",
    );

    const rawFalseTransform = await server.environments.client.transformRequest(
      "/raw-value-wrapper.js?raw=false",
    );
    const rawTransform = await server.environments.client.transformRequest(
      "/raw-value-wrapper.js?raw",
    );
    expect(rawFalseTransform?.code).toContain('import "/raw-value-wrapper.css"');
    expect(rawTransform?.code).toContain('export default "import \\"./raw-value-wrapper.css\\"');

    const rawFalseModule = await server.environments.client.moduleGraph.getModuleByUrl(
      "/raw-value-wrapper.js?raw=false",
    );
    const rawModule = await server.environments.client.moduleGraph.getModuleByUrl(
      "/raw-value-wrapper.js?raw",
    );
    expect([...rawFalseModule!.importedModules].map((moduleNode) => moduleNode.url)).toContain(
      "/raw-value-wrapper.css",
    );
    expect([...rawModule!.importedModules]).toEqual([]);

    for (const file of ["inline-wrapper.css", "raw-value-wrapper.css"]) {
      expect(html).toContain(`href="/${file}"`);
      expect(html).toContain(`data-vite-dev-id="${toSlash(path.join(root, file))}"`);
    }
  });

  it("uses Vite resolution for root URLs, encoded paths, /@fs/, queries, and manifest fallback", async () => {
    const graph = server.environments.client.moduleGraph;
    const encodedRootUrl = "/style%20sheet.css";

    const canonicalStylesheetPath = toSlash(stylesheetPath);
    expect(await resolvePagesDevStylesheetId(graph, encodedRootUrl)).toBe(canonicalStylesheetPath);
    expect(await resolvePagesDevStylesheetId(graph, `${encodedRootUrl}?theme=dark`)).toBe(
      `${canonicalStylesheetPath}?theme=dark`,
    );
    expect(
      await resolvePagesDevStylesheetId(
        graph,
        `/@fs/${encodeURI(canonicalStylesheetPath)}?direct=false`,
      ),
    ).toBe(`${canonicalStylesheetPath}?direct=false`);

    // Manifest assets are resolved before their CSS module has been transformed.
    expect(graph.getModuleById(canonicalStylesheetPath)).toBeUndefined();
  });

  it("deduplicates a manifest fallback against the later resolved graph asset", async () => {
    const entryPath = path.join(root, "manifest-transient-entry.js");
    const cssPath = path.join(root, "manifest-transient.css");
    fs.writeFileSync(entryPath, 'import "./manifest-transient.css";\n');
    fs.writeFileSync(cssPath, ".manifest-transient { color: green; }\n");
    const graph = server.environments.client.moduleGraph;
    const resolveUrl = vi
      .spyOn(graph, "resolveUrl")
      .mockRejectedValueOnce(new Error("Simulated manifest-only resolution failure"));

    let html: string;
    try {
      html = await collectPagesDevInitialStylesheetHeadHTML(
        server,
        {
          async import() {
            return {
              default: {
                ssrManifest: {
                  [entryPath]: ["manifest-transient.css"],
                },
              },
            };
          },
        },
        [entryPath],
        "",
      );
      expect(resolveUrl).toHaveBeenNthCalledWith(1, "/manifest-transient.css");
    } finally {
      resolveUrl.mockRestore();
    }

    expect(html.match(/href="\/manifest-transient\.css"/g)).toHaveLength(1);
    expect(html).toContain(`data-vite-dev-id="${toSlash(cssPath)}"`);
  });

  it("preserves safe virtual ids and omits null-byte ids that HTML cannot represent", async () => {
    const graph = server.environments.client.moduleGraph;

    expect(await resolvePagesDevStylesheetId(graph, "virtual:safe-style.css")).toBe(
      "virtual:safe-style.css?resolved",
    );
    expect(await resolvePagesDevStylesheetId(graph, "virtual:null-style.css")).toBeNull();
    expect(
      await resolvePagesDevStylesheetId(
        graph,
        "/ignored.css?query=kept",
        "/resolved.css?query=kept",
      ),
    ).toBe("/resolved.css?query=kept");
  });

  it("serves non-null custom virtual stylesheets through Vite's wrapped id URL", async () => {
    const entryPath = path.join(root, "safe-virtual-entry.js");
    fs.writeFileSync(entryPath, 'import "virtual:safe-style.css";\n');

    const html = await collectPagesDevInitialStylesheetHeadHTML(
      server,
      {
        async import() {
          throw new Error("No Pages manifest in this focused Vite fixture");
        },
      },
      [entryPath],
      "",
    );

    expect(html).toContain('data-vite-dev-id="virtual:safe-style.css?resolved"');
    const href = html.match(/href="([^"]+)"/)?.[1];
    expect(href).toBe("/@id/virtual:safe-style.css?resolved&amp;direct");

    const baseUrl = server.resolvedUrls?.local[0];
    expect(baseUrl).toBeDefined();
    const response = await fetch(new URL(href!.replaceAll("&amp;", "&"), baseUrl));
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("text/css");
    expect(await response.text()).toContain(".safe-virtual");
  });
});
