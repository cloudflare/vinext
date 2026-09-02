import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Plugin } from "vite";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
  type CdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";

const CAPTURE_RSC_REQUEST = "__vinextCaptureWorkerRscRequest";
const REGISTER_CDN_ADAPTER = "__vinextRegisterWorkerCdnAdapter";

function workerEntryVirtualModules(): Plugin {
  const modules = new Map([
    [
      "virtual:vinext-rsc-entry",
      `
export const __assetPrefix = "";
export const __basePath = "";
export const __imageAllowedWidths = [];
export const __imageConfig = {};
export const __prerenderSecret = "worker-prerender-secret";
export default async function rscHandler(request) {
  globalThis.${CAPTURE_RSC_REQUEST}(request);
  return new Response("ok");
}
`,
    ],
    [
      "virtual:vinext-app-request-entry",
      `
export const __assetPrefix = "";
export const __basePath = "";
export const __imageAllowedWidths = [];
export const __imageConfig = {};
export const __prerenderSecret = "worker-prerender-secret";
export default async function rscHandler(request, _ctx, dispatchResponseStage) {
  if (new URL(request.url).pathname === "/__vinext/prerender/readiness") {
    return dispatchResponseStage(request, { kind: "readiness-test" }, { cache: "bypass" });
  }
  globalThis.${CAPTURE_RSC_REQUEST}(request);
  return new Response("ok");
}
`,
    ],
    [
      "virtual:vinext-cache-adapters",
      `export function registerConfiguredCacheAdapters(env) {
  globalThis.${REGISTER_CDN_ADAPTER}?.(env);
}`,
    ],
    ["virtual:vinext-image-adapters", "export function registerConfiguredImageOptimizer() {}"],
  ]);

  return {
    name: "app-router-worker-entry-test-virtual-modules",
    resolveId(id) {
      return modules.has(id) ? `\0${id}` : null;
    },
    load(id) {
      return id.startsWith("\0") ? (modules.get(id.slice(1)) ?? null) : null;
    },
  };
}

describe("App Router Production server worker entry compatibility", () => {
  it("validates CDN routing and stamps build identity at the request-stage boundary", async () => {
    // No Next.js test port applies: CDN adapter validation and staged Worker
    // boundaries are vinext deployment contracts.
    const capturedRequests: Request[] = [];
    const capturedEnvs: unknown[] = [];
    Reflect.set(globalThis, CAPTURE_RSC_REQUEST, (request: Request) => {
      capturedRequests.push(request);
    });
    const adapter: CdnCacheAdapter = {
      ownsBackgroundRevalidation: false,
      async get() {
        return null;
      },
      async set() {},
      buildResponseHeaders() {
        return {};
      },
      buildResponseIdentityHeaders() {
        return { "X-Test-Build-Identity": "build-a" };
      },
      validateRequest(request) {
        return request.headers.has("X-Reject-Stage")
          ? new Response("retry", { status: 503 })
          : null;
      },
      async revalidateTag() {},
    };
    Reflect.set(globalThis, REGISTER_CDN_ADAPTER, (env: unknown) => {
      capturedEnvs.push(env);
      setCdnCacheAdapter(adapter);
    });

    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      server = await createServer({
        appType: "custom",
        configFile: false,
        logLevel: "silent",
        plugins: [workerEntryVirtualModules()],
        resolve: {
          alias: {
            "vinext/shims": path.resolve(import.meta.dirname, "../packages/vinext/src/shims"),
          },
        },
        server: { middlewareMode: true },
      });
      const entry = (await server.ssrLoadModule(
        path.resolve(
          import.meta.dirname,
          "../packages/vinext/src/server/app-request-stage-independent-entry.ts",
        ),
      )) as {
        handleRequestStage(
          request: Request,
          env: unknown,
          ctx: undefined,
          dispatchResponseStage: (
            request: Request,
            props: unknown,
            options: unknown,
          ) => Promise<Response>,
        ): Promise<Response>;
      };
      const env = { binding: "value" };
      const rejected = await entry.handleRequestStage(
        new Request("https://example.com/rejected", {
          headers: { Accept: "text/html", "X-Reject-Stage": "1" },
        }),
        env,
        undefined,
        async () => new Response("unused"),
      );
      const accepted = await entry.handleRequestStage(
        new Request("https://example.com/accepted", { headers: { Accept: "text/html" } }),
        env,
        undefined,
        async () => new Response("unused"),
      );
      const readinessDispatch = vi.fn<
        (request: Request, props: unknown, options: unknown) => Promise<Response>
      >(
        async () =>
          new Response(null, {
            status: 204,
            headers: { "Cache-Control": "no-store", "X-Vinext-Prerender-Readiness": "1" },
          }),
      );
      const readiness = await entry.handleRequestStage(
        new Request("https://example.com/__vinext/prerender/readiness?attempt=request-stage", {
          headers: {
            "X-Vinext-Expected-Worker-Version": "version-a",
            "X-Vinext-Prerender-Secret": "worker-prerender-secret",
          },
        }),
        env,
        undefined,
        readinessDispatch,
      );

      expect(rejected.status).toBe(503);
      expect(await rejected.text()).toBe("retry");
      expect(rejected.headers.get("X-Test-Build-Identity")).toBe("build-a");
      expect(await accepted.text()).toBe("ok");
      expect(accepted.headers.get("X-Test-Build-Identity")).toBe("build-a");
      expect(readiness.status).toBe(204);
      expect(readinessDispatch).toHaveBeenCalledWith(
        expect.any(Request),
        { kind: "readiness-test" },
        { cache: "bypass" },
      );
      const readinessStageRequest = readinessDispatch.mock.calls[0]![0] as Request;
      expect(readinessStageRequest.headers.get("X-Vinext-Expected-Worker-Version")).toBe(
        "version-a",
      );
      expect(readinessStageRequest.headers.get("X-Vinext-Prerender-Secret")).toBeNull();
      expect(capturedRequests).toHaveLength(1);
      expect(capturedEnvs).toEqual([env, env, env]);
    } finally {
      await server?.close();
      setCdnCacheAdapter(new DefaultCdnCacheAdapter());
      Reflect.deleteProperty(globalThis, CAPTURE_RSC_REQUEST);
      Reflect.deleteProperty(globalThis, REGISTER_CDN_ADAPTER);
    }
  });

  it("restores prerender route params only for the server-owned Node context", async () => {
    // No Next.js test port applies: these headers and this Worker boundary are vinext-specific.
    const capturedRequests: Request[] = [];
    Reflect.set(globalThis, CAPTURE_RSC_REQUEST, (request: Request) => {
      capturedRequests.push(request);
    });
    const previousPrerender = process.env.VINEXT_PRERENDER;
    process.env.VINEXT_PRERENDER = "1";

    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      server = await createServer({
        appType: "custom",
        configFile: false,
        logLevel: "silent",
        plugins: [workerEntryVirtualModules()],
        resolve: {
          alias: {
            "vinext/shims": path.resolve(import.meta.dirname, "../packages/vinext/src/shims"),
          },
        },
        server: { middlewareMode: true },
      });
      const entry = (await server.ssrLoadModule(
        path.resolve(import.meta.dirname, "../packages/vinext/src/server/app-router-entry.ts"),
      )) as {
        default: {
          fetch(
            request: Request,
            env?: unknown,
            ctx?: {
              waitUntil(promise: Promise<unknown>): void;
              hostRuntime?: "node" | "worker";
              trustedRevalidateOrigin?: string;
            },
          ): Promise<Response>;
        };
      };
      const routeParams = encodeURIComponent(
        JSON.stringify({
          fallbackParamNames: ["slug"],
          params: { slug: "attacker" },
          routePattern: "/blog/:slug",
        }),
      );

      const prerenderRequest = () =>
        new Request("https://example.com/blog/attacker", {
          headers: {
            "x-vinext-prerender-route-params": routeParams,
            "x-vinext-prerender-secret": "not-the-build-secret",
          },
        });

      // A deployed Worker receives the platform ExecutionContext, so an external
      // caller supplying both headers must not reach the RSC handler with them.
      await entry.default.fetch(prerenderRequest(), undefined, { waitUntil() {} });

      // prod-server verified the secret in nodeToWebRequest before building this
      // context, so the payload it re-serialized has to survive the entry filter.
      await entry.default.fetch(prerenderRequest(), undefined, {
        waitUntil() {},
        hostRuntime: "node",
        trustedRevalidateOrigin: "http://127.0.0.1:3000",
      });

      const readiness = await entry.default.fetch(
        new Request("https://example.com/__vinext/prerender/readiness", {
          headers: {
            accept: "text/html",
            "x-vinext-expected-worker-version": "version-a",
            "x-vinext-prerender-secret": "worker-prerender-secret",
          },
        }),
        undefined,
        { waitUntil() {} },
      );
      const unauthorizedReadiness = await entry.default.fetch(
        new Request("https://example.com/__vinext/prerender/readiness", {
          headers: {
            "x-vinext-expected-worker-version": "version-a",
            "x-vinext-prerender-secret": "wrong-secret",
          },
        }),
        undefined,
        { waitUntil() {} },
      );

      expect(capturedRequests).toHaveLength(2);
      expect(readiness.status).toBe(204);
      expect(readiness.headers.get("cache-control")).toBe("no-store");
      expect(readiness.headers.get("x-vinext-prerender-readiness")).toBe("1");
      expect(unauthorizedReadiness.status).toBe(404);
      expect(unauthorizedReadiness.headers.get("cache-control")).toBe("no-store");
      expect(capturedRequests[0].headers.get("x-vinext-prerender-secret")).toBeNull();
      expect(capturedRequests[0].headers.get("x-vinext-prerender-route-params")).toBeNull();
      expect(capturedRequests[1].headers.get("x-vinext-prerender-secret")).toBeNull();
      expect(capturedRequests[1].headers.get("x-vinext-prerender-route-params")).toBe(routeParams);
    } finally {
      await server?.close();
      Reflect.deleteProperty(globalThis, CAPTURE_RSC_REQUEST);
      if (previousPrerender === undefined) delete process.env.VINEXT_PRERENDER;
      else process.env.VINEXT_PRERENDER = previousPrerender;
    }
  });

  it("accepts Worker-style default exports from dist/server/index.js", async () => {
    const outDirs: string[] = [];
    function writeWorkerEntry(value: string): string {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prod-worker-entry-"));
      outDirs.push(outDir);
      const serverDir = path.join(outDir, "server");
      fs.mkdirSync(serverDir, { recursive: true });
      fs.mkdirSync(path.join(outDir, "client"), { recursive: true });
      fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }));
      fs.writeFileSync(
        path.join(serverDir, "entry-relative.cjs"),
        `module.exports = { value: ${JSON.stringify(value)} };\n`,
      );
      fs.writeFileSync(
        path.join(serverDir, "index.js"),
        `
const importValue = globalThis.require("./entry-relative.cjs").value;

export default {
  async fetch(request, env, ctx) {
    ctx?.waitUntil(Promise.resolve("background"));
    return new Response(
      JSON.stringify({
        pathname: new URL(request.url).pathname,
        hasWaitUntil: typeof ctx?.waitUntil === "function",
        envValue: env.VINEXT_WORKER_ENTRY_TEST,
        importValue,
        runtimeValue: globalThis.require("./entry-relative.cjs").value,
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
};
`,
      );
      return outDir;
    }

    const previousRequire = Object.getOwnPropertyDescriptor(globalThis, "require");
    const previousEnv = process.env.VINEXT_WORKER_ENTRY_TEST;
    Object.defineProperty(globalThis, "require", {
      configurable: true,
      value: () => ({ value: "wrong pre-existing resolver" }),
      writable: true,
    });
    process.env.VINEXT_WORKER_ENTRY_TEST = "passed through process.env";
    const servers: import("node:http").Server[] = [];

    try {
      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      const entries = ["first entry", "second entry"];
      const started = await Promise.all(
        entries.map((value) =>
          startProdServer({ port: 0, outDir: writeWorkerEntry(value), noCompression: true }),
        ),
      );
      servers.push(...started.map(({ server }) => server));

      for (const [{ port }, value] of started.map(
        (server, index) => [server, entries[index]] as const,
      )) {
        const res = await fetch(`http://localhost:${port}/worker-test`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          pathname: "/worker-test",
          hasWaitUntil: true,
          envValue: "passed through process.env",
          importValue: value,
          runtimeValue: value,
        });
      }
    } finally {
      for (const server of servers) server.close();
      if (previousRequire) {
        Object.defineProperty(globalThis, "require", previousRequire);
      } else {
        Reflect.deleteProperty(globalThis, "require");
      }
      if (previousEnv === undefined) delete process.env.VINEXT_WORKER_ENTRY_TEST;
      else process.env.VINEXT_WORKER_ENTRY_TEST = previousEnv;
      for (const outDir of outDirs) fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("reports a clear error for unsupported app router entry shapes", async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prod-worker-invalid-"));
    const serverDir = path.join(outDir, "server");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(path.join(serverDir, "index.js"), "export default {};\n");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      await expect(startProdServer({ port: 0, outDir, noCompression: true })).rejects.toThrow(
        "process.exit(1)",
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "[vinext] App Router entry must export either a default handler function or a Worker-style default export with fetch()",
      );
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
