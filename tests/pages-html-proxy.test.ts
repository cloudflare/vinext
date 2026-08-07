import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { createServer } from "vite-plus";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createPagesHtmlProxyCapturePlugin,
  transformPagesHtml,
} from "../packages/vinext/src/server/pages-html-proxy.js";

const CONTENT_MODULE_RE = /src="([^"]*__vinext_html_proxy_content_[^"]+\.js)"/g;

function contentModuleUrls(html: string): string[] {
  return Array.from(html.matchAll(CONTENT_MODULE_RE), (match) => match[1]!);
}

describe("Pages HTML proxy capture", () => {
  const servers: ViteDevServer[] = [];
  const roots: string[] = [];

  async function createTestServer(
    options: { base?: string; cspNonce?: string; plugins?: Plugin[] } = {},
  ) {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-pages-html-proxy-"));
    roots.push(root);
    const capturePlugin = createPagesHtmlProxyCapturePlugin();
    const server = await createServer({
      appType: "custom",
      base: options.base,
      html: options.cspNonce ? { cspNonce: options.cspNonce } : undefined,
      logLevel: "silent",
      plugins: [capturePlugin, ...(options.plugins ?? [])],
      root,
    });
    servers.push(server);
    return { capturePlugin, root, server };
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("does not rewrite ordinary non-Pages HTML transforms", async () => {
    const { server } = await createTestServer();
    const transformed = await server.transformIndexHtml(
      "/ordinary",
      `<script type="module">ordinary()</script>`,
    );

    expect(transformed).toContain("html-proxy&index=0.js");
    expect(transformed).not.toContain("__vinext_html_proxy_content_");
  });

  it("preserves user hook paths and captures trailing-slash document proxies", async () => {
    const hookPaths: string[] = [];
    const { server } = await createTestServer({
      plugins: [
        {
          name: "test:observe-real-html-path",
          transformIndexHtml: {
            order: "pre",
            handler(html, context) {
              hookPaths.push(context.path);
              return html;
            },
          },
        },
      ],
    });
    const root = await transformPagesHtml(
      server,
      "/",
      `<script type="module">rootDocument()</script>`,
    );
    const nested = await transformPagesHtml(
      server,
      "/nested/",
      `<script type="module">nestedDocument()</script>`,
    );
    const nestedWithQuery = await transformPagesHtml(
      server,
      "/nested/?q=1",
      `<script type="module">nestedQueryDocument()</script>`,
    );
    const rootWithQuery = await transformPagesHtml(
      server,
      "/?q=1",
      `<script type="module">rootQueryDocument()</script>`,
    );

    expect(hookPaths).toEqual(["/", "/nested/", "/nested/?q=1", "/?q=1"]);
    expect(contentModuleUrls(root)).toHaveLength(1);
    expect(contentModuleUrls(nested)).toHaveLength(1);
    expect(contentModuleUrls(nestedWithQuery)).toHaveLength(1);
    expect(contentModuleUrls(rootWithQuery)).toHaveLength(1);
  });

  it("captures Vite's filesystem-backed proxy form when a document path exists", async () => {
    const { root, server } = await createTestServer();
    await mkdir(path.join(root, "collision"));
    const transformed = await transformPagesHtml(
      server,
      "/collision",
      `<script type="module">collisionDocument()</script>`,
    );
    const [url] = contentModuleUrls(transformed);

    expect(url).toBeDefined();
    await expect(server.transformRequest(url!)).resolves.toMatchObject({
      code: expect.stringContaining("collisionDocument()"),
    });
  });

  it("reuses immutable modules when only non-module HTML changes", async () => {
    const { server } = await createTestServer();
    const first = await transformPagesHtml(
      server,
      "/page",
      `<script type="module">sameModule()</script><p>first body</p>`,
    );
    const second = await transformPagesHtml(
      server,
      "/page",
      `<script type="module">sameModule()</script><p>second body</p>`,
    );

    expect(contentModuleUrls(first)).toEqual(contentModuleUrls(second));
    expect(first).toContain("first body");
    expect(second).toContain("second body");
  });

  it("captures stateful pre-hook output instead of hashing its input", async () => {
    let transformCount = 0;
    const { server } = await createTestServer({
      plugins: [
        {
          name: "test:stateful-html-pre-hook",
          transformIndexHtml: {
            order: "pre",
            handler(html) {
              transformCount += 1;
              return html.replace("stateful()", `stateful(${transformCount})`);
            },
          },
        },
      ],
    });
    const input = `<script type="module">stateful()</script>`;
    const first = await transformPagesHtml(server, "/page", input);
    const second = await transformPagesHtml(server, "/page", input);
    const [firstUrl] = contentModuleUrls(first);
    const [secondUrl] = contentModuleUrls(second);

    expect(firstUrl).not.toBe(secondUrl);
    expect((await server.transformRequest(firstUrl!))?.code).toContain("stateful(1)");
    expect((await server.transformRequest(secondUrl!))?.code).toContain("stateful(2)");
  });

  it("bounds retained request-dependent proxy modules", async () => {
    const { server } = await createTestServer();
    const renderedUrls: string[] = [];

    for (let index = 0; index < 300; index += 1) {
      const transformed = await transformPagesHtml(
        server,
        "/page",
        `<script type="module">renderVersion(${index})</script>`,
      );
      const url = contentModuleUrls(transformed)[0]!;
      renderedUrls.push(url);
      await server.transformRequest(url);
    }

    const graph = server.environments.client.moduleGraph;
    const retainedGraphUrls = Array.from(graph.urlToModuleMap.keys()).filter((url) =>
      url.includes("__vinext_html_proxy_content_"),
    );
    const unresolvedUrls = Array.from(
      (
        graph as unknown as {
          _unresolvedUrlToModuleMap: Map<string, unknown>;
        }
      )._unresolvedUrlToModuleMap.keys(),
    ).filter((url) => url.includes("__vinext_html_proxy_content_"));
    expect(retainedGraphUrls.length).toBeLessThanOrEqual(8);
    expect(unresolvedUrls.length).toBeLessThanOrEqual(8);
    await expect(server.transformRequest(renderedUrls[0]!)).rejects.toThrow();
    await expect(server.transformRequest(renderedUrls.at(-1)!)).resolves.toMatchObject({
      code: expect.stringContaining("renderVersion(299)"),
    });
  });

  it("bounds retained modules across distinct document URLs", async () => {
    const { server } = await createTestServer();
    const renderedUrls: string[] = [];

    for (let index = 0; index < 160; index += 1) {
      const transformed = await transformPagesHtml(
        server,
        `/docs/${index}`,
        `<script type="module">documentVersion(${index})</script>`,
      );
      const url = contentModuleUrls(transformed)[0]!;
      renderedUrls.push(url);
      await server.transformRequest(url);
    }

    const graph = server.environments.client.moduleGraph;
    const retainedGraphUrls = Array.from(graph.urlToModuleMap.keys()).filter((url) =>
      url.includes("__vinext_html_proxy_content_"),
    );
    expect(retainedGraphUrls.length).toBeLessThanOrEqual(128);
    await expect(server.transformRequest(renderedUrls[0]!)).rejects.toThrow();
    await expect(server.transformRequest(renderedUrls.at(-1)!)).resolves.toMatchObject({
      code: expect.stringContaining("documentVersion(159)"),
    });
  });

  it("evicts retained proxies when the source graph updates", async () => {
    const { capturePlugin, server } = await createTestServer();
    const transformed = await transformPagesHtml(
      server,
      "/page",
      `<script type="module">beforeUpdate()</script>`,
    );
    const url = contentModuleUrls(transformed)[0]!;
    await expect(server.transformRequest(url)).resolves.toMatchObject({
      code: expect.stringContaining("beforeUpdate()"),
    });

    const hotUpdate = capturePlugin.hotUpdate;
    if (typeof hotUpdate !== "function") throw new Error("Expected a hotUpdate handler");
    await hotUpdate.call(undefined as never, { server } as never);

    await expect(server.transformRequest(url)).rejects.toThrow();
  });

  it("retains every current proxy index in a document", async () => {
    const { server } = await createTestServer();
    const transformed = await transformPagesHtml(
      server,
      "/page",
      Array.from(
        { length: 12 },
        (_, index) => `<script type="module">currentModule(${index})</script>`,
      ).join(""),
    );
    const urls = contentModuleUrls(transformed);

    expect(urls).toHaveLength(12);
    const results = await Promise.all(urls.map((url) => server.transformRequest(url)));
    for (let index = 0; index < results.length; index += 1) {
      expect(results[index]?.code).toContain(`currentModule(${index})`);
    }
  });

  it("finishes eviction when Vite module resolution is still pending", async () => {
    const { server } = await createTestServer();
    const first = await transformPagesHtml(
      server,
      "/page",
      `<script type="module">pendingVersion(0)</script>`,
    );
    const firstUrl = contentModuleUrls(first)[0]!;
    const graph = server.environments.client.moduleGraph;
    const internals = graph as unknown as {
      _resolveId: (url: string) => Promise<{ id: string } | null>;
      _unresolvedUrlToModuleMap: Map<string, unknown>;
    };
    const originalResolveId = internals._resolveId.bind(graph);
    let releaseResolution!: () => void;
    const resolutionGate = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    internals._resolveId = async (url) => {
      if (url === firstUrl) await resolutionGate;
      return originalResolveId(url);
    };

    const pendingModule = graph.ensureEntryFromUrl(firstUrl);
    expect(internals._unresolvedUrlToModuleMap.get(firstUrl)).toBeInstanceOf(Promise);
    for (let index = 1; index <= 8; index += 1) {
      await transformPagesHtml(
        server,
        "/page",
        `<script type="module">pendingVersion(${index})</script>`,
      );
    }

    releaseResolution();
    await pendingModule;
    await Promise.resolve();
    expect(graph.urlToModuleMap.has(firstUrl)).toBe(false);
    expect(internals._unresolvedUrlToModuleMap.has(firstUrl)).toBe(false);
  });

  it("keeps duplicate modules and Vite proxy indices distinct", async () => {
    const { server } = await createTestServer();
    const transformed = await transformPagesHtml(
      server,
      "/page",
      `<script type="module">duplicate()</script>
       <div style="background: url('/asset.png')"></div>
       <script type="module">duplicate()</script>`,
    );
    const urls = contentModuleUrls(transformed);

    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toBe(urls[1]);
    expect(urls[0]).toMatch(/_0\.js$/);
    expect(urls[1]).toMatch(/_2\.js$/);
    await expect(server.transformRequest(urls[0]!)).resolves.toMatchObject({
      code: expect.stringContaining("duplicate()"),
    });
    await expect(server.transformRequest(urls[1]!)).resolves.toMatchObject({
      code: expect.stringContaining("duplicate()"),
    });
  });

  it("preserves base paths, encoded document directories, CSP nonces, and hook order", async () => {
    let normalHtml = "";
    let postHtml = "";
    const { root, server } = await createTestServer({
      base: "/base/",
      plugins: [
        {
          name: "test:observe-normal-html",
          transformIndexHtml(html) {
            normalHtml = html;
          },
        },
        {
          name: "test:observe-post-html",
          transformIndexHtml: {
            order: "post",
            handler(html) {
              postHtml = html;
            },
          },
        },
      ],
    });
    await mkdir(path.join(root, "nested directory"), { recursive: true });
    await writeFile(
      path.join(root, "nested directory", "dep.js"),
      `export const encodedDirectoryValue = "resolved";`,
    );
    const transformed = await transformPagesHtml(
      server,
      "/nested%20directory/page",
      `<script type="module" nonce="test-nonce">
        import { encodedDirectoryValue } from "./dep.js";
        withNonce(encodedDirectoryValue);
      </script>`,
      "test-nonce",
    );
    const [url] = contentModuleUrls(transformed);

    expect(url).toMatch(/^\/base\/nested%20directory\/__vinext_html_proxy_content_/);
    expect(transformed).toContain('nonce="test-nonce"');
    expect(normalHtml).toContain(url);
    expect(postHtml).toContain(url);
    await expect(server.transformRequest(url!)).resolves.toMatchObject({
      code: expect.stringContaining("nested directory/dep.js"),
    });

    const percentEncoded = await transformPagesHtml(
      server,
      "/encoded%25directory/page",
      `<script type="module">encodedPercent()</script>`,
    );
    const [percentUrl] = contentModuleUrls(percentEncoded);
    expect(percentUrl).toContain("/base/encoded%25directory/");
    await expect(server.transformRequest(percentUrl!)).resolves.toMatchObject({
      code: expect.stringContaining("encodedPercent()"),
    });
  });

  it("keeps an encoded public base separate from decoded filesystem paths", async () => {
    const { root, server } = await createTestServer({
      base: "/base%20directory/",
      cspNonce: "static-nonce",
    });
    await mkdir(path.join(root, "nested directory"), { recursive: true });
    await writeFile(
      path.join(root, "nested directory", "dep.js"),
      `export const encodedBaseValue = "resolved";`,
    );
    const transformed = await transformPagesHtml(
      server,
      "/nested%20directory/page",
      `<script type="module">
        import { encodedBaseValue } from "./dep.js";
        useEncodedBase(encodedBaseValue);
      </script>`,
    );
    const [url] = contentModuleUrls(transformed);

    expect(url).toMatch(/^\/base%20directory\/nested%20directory\/__vinext_html_proxy_content_/);
    expect(transformed).toContain('nonce="static-nonce"');
    await expect(server.transformRequest(url!)).resolves.toMatchObject({
      code: expect.stringContaining("nested directory/dep.js"),
    });
  });

  it("resolves relative imports from the original nested document", async () => {
    const { root, server } = await createTestServer();
    await writeFile(path.join(root, "nested-relative.js"), `export const relativeValue = "ok";`);
    const transformed = await transformPagesHtml(
      server,
      "/nested/page",
      `<script type="module">
        import { relativeValue } from "../nested-relative.js";
        window.__relativeValue = relativeValue;
      </script>`,
    );
    const [url] = contentModuleUrls(transformed);
    const result = await server.transformRequest(url!);

    expect(result?.code).toContain("/nested-relative.js");
    expect(result?.code).toContain("window.__relativeValue = relativeValue");
  });

  it("releases the per-document lock when an HTML transform throws", async () => {
    let shouldThrow = true;
    const { server } = await createTestServer({
      plugins: [
        {
          name: "test:throw-once",
          transformIndexHtml: {
            order: "post",
            handler() {
              if (!shouldThrow) return;
              shouldThrow = false;
              throw new Error("intentional transform failure");
            },
          },
        },
      ],
    });

    await expect(
      transformPagesHtml(server, "/page", `<script type="module">first()</script>`),
    ).rejects.toThrow("intentional transform failure");
    const recovered = await transformPagesHtml(
      server,
      "/page",
      `<script type="module">recovered()</script>`,
    );

    expect(contentModuleUrls(recovered)).toHaveLength(1);
    await expect(server.transformRequest(contentModuleUrls(recovered)[0]!)).resolves.toMatchObject({
      code: expect.stringContaining("recovered()"),
    });
  });
});
