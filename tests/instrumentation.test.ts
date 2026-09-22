import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as Sentry from "@sentry/nextjs";
import { createServer, parseAst } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";
import { createDirectRunner } from "../packages/vinext/src/server/dev-module-runner.js";
import {
  findInstrumentationClientFile,
  findInstrumentationFile,
} from "../packages/vinext/src/server/instrumentation.js";
import { toSlash } from "pathslash";
import { generateInstrumentationClientInjectModule } from "../packages/vinext/src/client/instrumentation-client-inject.js";
import { createValidFileMatcher } from "../packages/vinext/src/routing/file-matcher.js";
import {
  createInstrumentationClientTransformPlugin,
  createInstrumentationServerTransformPlugin,
} from "../packages/vinext/src/plugins/instrumentation-client.js";

const RESOLVED_INSTRUMENTATION_CLIENT = "\0private-next-instrumentation-client.mjs";
const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "..", "node_modules");

type SentryEnvelopeEvent = {
  exception?: {
    values?: Array<{
      value?: string;
    }>;
  };
  contexts?: {
    nextjs?: {
      request_path?: string;
      router_kind?: string;
      router_path?: string;
      route_type?: string;
    };
  };
  transaction?: string;
};

function getLoadedCode(loaded: unknown): string {
  return typeof loaded === "string" ? loaded : ((loaded as { code?: string })?.code ?? "");
}

function parseSentryEnvelopeEvents(envelope: unknown): SentryEnvelopeEvent[] {
  if (Array.isArray(envelope)) {
    const [, items] = envelope as [unknown, Array<[unknown, SentryEnvelopeEvent]>];
    return (items ?? []).map(([, payload]) => payload).filter((payload) => payload.exception);
  }

  if (typeof envelope !== "string") return [];

  const events: SentryEnvelopeEvent[] = [];
  for (const line of envelope.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as SentryEnvelopeEvent;
      if (parsed.exception) events.push(parsed);
    } catch {
      /* Sentry envelope item headers are JSON too; ignore anything else. */
    }
  }
  return events;
}

function getTransformHandler(
  plugin: ReturnType<typeof createInstrumentationClientTransformPlugin>,
) {
  if (typeof plugin.transform === "function") return plugin.transform;
  if (plugin.transform?.handler) return plugin.transform.handler;
  throw new Error("transform hook missing");
}

function setupInjectProject(options: {
  instrumentationClientInject: string[];
  injectFiles?: Record<string, string>;
  userClientSource?: string;
}): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-instr-client-inject-"));
  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({ name: "test-project", type: "module" }),
  );
  fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "app", "layout.tsx"),
    "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n",
  );
  fs.writeFileSync(
    path.join(tmpDir, "app", "page.tsx"),
    "export default function Page() { return <div>home</div>; }\n",
  );
  fs.writeFileSync(
    path.join(tmpDir, "next.config.mjs"),
    `export default { instrumentationClientInject: ${JSON.stringify(options.instrumentationClientInject)} };\n`,
  );
  for (const [filename, source] of Object.entries(options.injectFiles ?? {})) {
    fs.writeFileSync(path.join(tmpDir, filename), source);
  }
  if (options.userClientSource !== undefined) {
    fs.writeFileSync(path.join(tmpDir, "instrumentation-client.js"), options.userClientSource);
  }
  try {
    fs.symlinkSync(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");
  } catch {
    fs.symlinkSync(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "dir");
  }
  return tmpDir;
}

type InjectClientContainer = NonNullable<
  Awaited<ReturnType<typeof createServer>>["environments"]["client"]
>["pluginContainer"];

async function withInjectClientServer(
  options: {
    instrumentationClientInject: string[];
    injectFiles?: Record<string, string>;
    userClientSource?: string;
  },
  run: (ctx: { tmpDir: string; container: InjectClientContainer }) => Promise<void>,
): Promise<void> {
  const tmpDir = setupInjectProject(options);
  const testServer = await createServer({
    root: tmpDir,
    configFile: false,
    plugins: [vinext({ appDir: tmpDir })],
    server: { port: 0 },
    logLevel: "silent",
  });
  try {
    const client = testServer.environments.client;
    if (!client) throw new Error("client environment missing");
    await run({ tmpDir, container: client.pluginContainer });
  } finally {
    await testServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// The runInstrumentation/reportRequestError describe blocks re-import via
// vi.resetModules() to get fresh module-level state (_onRequestError).
// findInstrumentationFile is a pure function — no reset needed.

describe("instrumentation server-only imports", () => {
  // Ported from Next.js: test/e2e/instrumentation-hook/general/instrumentation.js
  // https://github.com/vercel/next.js/blob/canary/test/e2e/instrumentation-hook/general/instrumentation.js
  it.each([
    { directory: "", direct: true, symlink: false },
    { directory: "", direct: false, symlink: false },
    { directory: "src", direct: false, symlink: false },
    { directory: "src", direct: false, symlink: true },
  ])("allows SSR startup imports: %j", async ({ directory, direct, symlink }) => {
    const tmpDir = setupInjectProject({ instrumentationClientInject: [] });
    const sourceDir = path.join(tmpDir, directory);
    fs.mkdirSync(sourceDir, { recursive: true });
    const instrumentationPath = path.join(sourceDir, "instrumentation.ts");
    const implementationPath = symlink ? path.join(sourceDir, "startup.ts") : instrumentationPath;
    fs.writeFileSync(
      implementationPath,
      `${direct ? 'import "server-only";' : ""}
export async function register() {
  const { initialized } = await import("./server-init");
  return initialized;
}
`,
    );
    if (symlink) fs.symlinkSync(implementationPath, instrumentationPath);
    fs.writeFileSync(
      path.join(sourceDir, "server-init.ts"),
      'import "server-only"; export const initialized = "server initialized";',
    );
    fs.writeFileSync(
      path.join(tmpDir, "client-component.tsx"),
      '"use client"; import "server-only"; export default function Client() { return null; }',
    );

    const server = await createServer({
      root: tmpDir,
      configFile: false,
      plugins: [vinext({ appDir: tmpDir })],
      server: { middlewareMode: true, watch: null },
      logLevel: "silent",
    });
    const runner = createDirectRunner(server.environments.ssr);
    try {
      const instrumentation = await runner.import<{ register: () => Promise<string> }>(
        instrumentationPath,
      );
      await expect(instrumentation.register()).resolves.toBe("server initialized");
      // Allowing server instrumentation must not disable SSR validation for
      // actual Client Components.
      await expect(runner.import(path.join(tmpDir, "client-component.tsx"))).rejects.toThrow(
        /'server-only' cannot be imported in client build \('ssr' environment\)/,
      );
    } finally {
      await runner.close();
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("findInstrumentationFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    // Production always passes a forward-slash root (the config hook normalizes
    // it), so mirror that here — findInstrumentationFile now returns
    // forward-slash paths via path.posix.join.
    tmpDir = toSlash(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-instr-")));
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the path when a file exists at root", () => {
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), "");

    const result = findInstrumentationFile(tmpDir, createValidFileMatcher());

    expect(result).toBe(path.posix.join(tmpDir, "instrumentation.ts"));
  });

  it("prefers root over src/ directory (priority order)", () => {
    // Create both root and src/ variants
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), "");
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "instrumentation.ts"), "");

    const result = findInstrumentationFile(tmpDir, createValidFileMatcher());

    // Root files come first in INSTRUMENTATION_FILES, so root wins
    expect(result).toBe(path.posix.join(tmpDir, "instrumentation.ts"));
  });

  it("falls back to src/ directory", () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "instrumentation.ts"), "");

    const result = findInstrumentationFile(tmpDir, createValidFileMatcher());

    expect(result).toBe(path.posix.join(tmpDir, "src", "instrumentation.ts"));
  });

  it("returns null when no instrumentation file exists", () => {
    const result = findInstrumentationFile(tmpDir, createValidFileMatcher());

    expect(result).toBeNull();
  });
});

describe("instrumentation-client transform", () => {
  const path = "/project/instrumentation-client.ts";
  const source = 'import "./setup.js";\ninitialize();\n';

  it("injects a wrapped config route manifest in production without the dev timer", async () => {
    const manifest = JSON.stringify({ dynamicRoutes: ["/products/:id"] });
    const plugin = createInstrumentationClientTransformPlugin(
      () => path,
      () => manifest,
    );
    const transform = getTransformHandler(plugin);
    const result = await transform.call({} as never, source, path);
    const code = getLoadedCode(result);

    expect(code).toContain(`globalThis["_sentryRouteManifest"] = ${JSON.stringify(manifest)};`);
    expect(code.indexOf("_sentryRouteManifest")).toBeLessThan(code.indexOf("initialize()"));
    expect(code).not.toContain("__vinextInstrumentationClientStart");
  });

  it("injects the route manifest alongside the timer in development", async () => {
    const manifest = JSON.stringify({ dynamicRoutes: ["/products/:id"] });
    const plugin = createInstrumentationClientTransformPlugin(
      () => path,
      () => manifest,
    );
    const configResolved =
      typeof plugin.configResolved === "function"
        ? plugin.configResolved
        : plugin.configResolved?.handler;
    await configResolved?.call({} as never, { command: "serve" } as never);

    const code = getLoadedCode(await getTransformHandler(plugin).call({} as never, source, path));
    expect(code).toContain(`globalThis["_sentryRouteManifest"] = ${JSON.stringify(manifest)};`);
    expect(code).toContain("__vinextInstrumentationClientStart");
  });

  it("injects before executable statements without breaking directives", async () => {
    const plugin = createInstrumentationClientTransformPlugin(
      () => path,
      () => "manifest",
    );
    const sourceWithLateImport = '"use strict";\ninitialize();\nimport "./setup.js";\n';
    const code = getLoadedCode(
      await getTransformHandler(plugin).call({} as never, sourceWithLateImport, path),
    );

    expect(parseAst(code).body[0]).toMatchObject({ directive: "use strict" });
    expect(code.indexOf('globalThis["_sentryRouteManifest"]')).toBeGreaterThan(
      code.indexOf('"use strict"'),
    );
    expect(code.indexOf('globalThis["_sentryRouteManifest"]')).toBeLessThan(
      code.indexOf("initialize()"),
    );
  });

  it("keeps route manifest injection disabled when a wrapped config omits it", async () => {
    const plugin = createInstrumentationClientTransformPlugin(
      () => path,
      () => undefined,
    );
    const transform = getTransformHandler(plugin);
    expect(await transform.call({} as never, source, path)).toBeNull();
  });
});

describe("server instrumentation value transform", () => {
  const path = "/project/instrumentation.ts";
  const source = 'import "./setup.js";\nexport function register() {}\n';

  it("injects wrapped-config values into the instrumentation module", async () => {
    const plugin = createInstrumentationServerTransformPlugin(
      () => path,
      () => ({ objectValue: { enabled: true }, stringValue: "value", unsetValue: undefined }),
    );
    const code = getLoadedCode(await getTransformHandler(plugin).call({} as never, source, path));

    expect(code).toContain('globalThis["objectValue"] = {"enabled":true};');
    expect(code).toContain('globalThis["stringValue"] = "value";');
    expect(code).toContain('globalThis["unsetValue"] = undefined;');
    expect(code.indexOf("__vinextInstrumentationServerValues")).toBeLessThan(
      code.indexOf("export function register"),
    );
  });

  it("ignores unrelated modules and empty value maps", async () => {
    const values: Record<string, unknown> = {};
    const plugin = createInstrumentationServerTransformPlugin(
      () => path,
      () => values,
    );
    const transform = getTransformHandler(plugin);

    expect(await transform.call({} as never, source, "/project/other.ts")).toBeNull();
    expect(await transform.call({} as never, source, path)).toBeNull();
  });

  it("does not apply server value injection to the client environment", () => {
    const plugin = createInstrumentationServerTransformPlugin(
      () => path,
      () => ({ serverOnly: true }),
    );
    const apply = plugin.applyToEnvironment!;

    expect(apply({ name: "client" } as never)).toBe(false);
    expect(apply({ name: "rsc" } as never)).toBe(true);
    expect(apply({ name: "ssr" } as never)).toBe(true);
  });
});

describe("findInstrumentationClientFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = toSlash(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-instr-client-")));
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the path when a file exists at root", () => {
    fs.writeFileSync(path.join(tmpDir, "instrumentation-client.ts"), "");

    const result = findInstrumentationClientFile(tmpDir, createValidFileMatcher());

    expect(result).toBe(path.posix.join(tmpDir, "instrumentation-client.ts"));
  });

  it("prefers root over src/ directory (priority order)", () => {
    fs.writeFileSync(path.join(tmpDir, "instrumentation-client.ts"), "");
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "instrumentation-client.ts"), "");

    const result = findInstrumentationClientFile(tmpDir, createValidFileMatcher());

    expect(result).toBe(path.posix.join(tmpDir, "instrumentation-client.ts"));
  });

  it("falls back to src/ directory", () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "instrumentation-client.ts"), "");

    const result = findInstrumentationClientFile(tmpDir, createValidFileMatcher());

    expect(result).toBe(path.posix.join(tmpDir, "src", "instrumentation-client.ts"));
  });

  it("returns null when no instrumentation-client file exists", () => {
    const result = findInstrumentationClientFile(tmpDir, createValidFileMatcher());

    expect(result).toBeNull();
  });
});

describe("runInstrumentation", () => {
  let runInstrumentation: typeof import("../packages/vinext/src/server/instrumentation.js").runInstrumentation;
  let getOnRequestErrorHandler: typeof import("../packages/vinext/src/server/instrumentation.js").getOnRequestErrorHandler;

  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("vinext.instrumentation.state")];
    const mod = await import("../packages/vinext/src/server/instrumentation.js");
    runInstrumentation = mod.runInstrumentation;
    getOnRequestErrorHandler = mod.getOnRequestErrorHandler;
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("vinext.instrumentation.state")];
    delete globalThis.__VINEXT_onRequestErrorHandler__;
  });

  it("calls register() when exported", async () => {
    const register = vi.fn();
    const runner = {
      import: vi.fn().mockResolvedValue({ register }),
    };

    await runInstrumentation(runner, "/fake/instrumentation.ts");

    expect(register).toHaveBeenCalledOnce();
  });

  it("stores onRequestError handler for later retrieval", async () => {
    const onRequestError = vi.fn();
    const runner = {
      import: vi.fn().mockResolvedValue({ onRequestError }),
    };

    await runInstrumentation(runner, "/fake/instrumentation.ts");

    expect(getOnRequestErrorHandler()).toBe(onRequestError);
  });

  it("handles modules with no register or onRequestError gracefully", async () => {
    const runner = {
      import: vi.fn().mockResolvedValue({}),
    };

    // Should not throw
    await runInstrumentation(runner, "/fake/instrumentation.ts");

    expect(getOnRequestErrorHandler()).toBeNull();
  });

  it("propagates instrumentation import failures", async () => {
    const runner = {
      import: vi.fn().mockRejectedValue(new Error("Module not found")),
    };

    await expect(runInstrumentation(runner, "/fake/instrumentation.ts")).rejects.toThrow(
      "Module not found",
    );
  });
});

describe("ensureInstrumentationRegistered", () => {
  let ensureInstrumentationRegistered: typeof import("../packages/vinext/src/server/instrumentation-runtime.js").ensureInstrumentationRegistered;
  let reportRequestError: typeof import("../packages/vinext/src/server/instrumentation.js").reportRequestError;

  const sampleRequest = { path: "/test", method: "GET", headers: {} };
  const sampleContext = {
    routerKind: "App Router" as const,
    routePath: "/test",
    routeType: "render" as const,
    revalidateReason: undefined,
  };

  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("vinext.instrumentation.state")];
    delete globalThis.__VINEXT_onRequestErrorHandler__;
    delete process.env.VINEXT_PRERENDER;
    const mod = await import("../packages/vinext/src/server/instrumentation-runtime.js");
    ensureInstrumentationRegistered = mod.ensureInstrumentationRegistered;
    const instMod = await import("../packages/vinext/src/server/instrumentation.js");
    reportRequestError = instMod.reportRequestError;
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("vinext.instrumentation.state")];
    delete globalThis.__VINEXT_onRequestErrorHandler__;
    delete process.env.VINEXT_PRERENDER;
  });

  it("calls register() when exported", async () => {
    const register = vi.fn();

    await ensureInstrumentationRegistered({ register });

    expect(register).toHaveBeenCalledOnce();
  });

  it("wires onRequestError so reportRequestError invokes it", async () => {
    const onRequestError = vi.fn();
    const error = new Error("boom");

    await ensureInstrumentationRegistered({ onRequestError });
    await reportRequestError(error, sampleRequest, sampleContext);

    expect(onRequestError).toHaveBeenCalledWith(error, sampleRequest, sampleContext);
  });

  it("is idempotent — register() called only once across concurrent awaits", async () => {
    const register = vi.fn();
    const mod = { register };

    await Promise.all([
      ensureInstrumentationRegistered(mod),
      ensureInstrumentationRegistered(mod),
      ensureInstrumentationRegistered(mod),
    ]);

    expect(register).toHaveBeenCalledOnce();
  });

  it("is idempotent — sequential awaits do not re-call register()", async () => {
    const register = vi.fn();
    const mod = { register };

    await ensureInstrumentationRegistered(mod);
    await ensureInstrumentationRegistered(mod);

    expect(register).toHaveBeenCalledOnce();
  });

  it("is idempotent across duplicate bundled module instances", async () => {
    const register = vi.fn();
    const instrumentationModule = { register };

    await ensureInstrumentationRegistered(instrumentationModule);
    vi.resetModules();
    const duplicate = await import("../packages/vinext/src/server/instrumentation-runtime.js");
    await duplicate.ensureInstrumentationRegistered(instrumentationModule);

    expect(register).toHaveBeenCalledOnce();
  });

  it("deduplicates separate environment module instances by instrumentation path", async () => {
    const firstRegister = vi.fn();
    const secondRegister = vi.fn();

    await ensureInstrumentationRegistered({ register: firstRegister }, "/app/instrumentation.ts");
    await ensureInstrumentationRegistered({ register: secondRegister }, "/app/instrumentation.ts");

    expect(firstRegister).toHaveBeenCalledOnce();
    expect(secondRegister).not.toHaveBeenCalled();
  });

  it("registers distinct instrumentation modules independently", async () => {
    const firstRegister = vi.fn();
    const secondRegister = vi.fn();

    await ensureInstrumentationRegistered({ register: firstRegister });
    await ensureInstrumentationRegistered({ register: secondRegister });

    expect(firstRegister).toHaveBeenCalledOnce();
    expect(secondRegister).toHaveBeenCalledOnce();
  });

  it("no-ops when VINEXT_PRERENDER is set", async () => {
    process.env.VINEXT_PRERENDER = "1";
    const register = vi.fn();

    await ensureInstrumentationRegistered({ register });

    expect(register).not.toHaveBeenCalled();
  });

  it("does not throw when module has no register or onRequestError", async () => {
    await ensureInstrumentationRegistered({});

    // Should not throw
    await reportRequestError(new Error("boom"), sampleRequest, sampleContext);
  });
});

describe("reportRequestError", () => {
  let runInstrumentation: typeof import("../packages/vinext/src/server/instrumentation.js").runInstrumentation;
  let reportRequestError: typeof import("../packages/vinext/src/server/instrumentation.js").reportRequestError;
  let runWithExecutionContext: typeof import("../packages/vinext/src/shims/request-context.js").runWithExecutionContext;

  const sampleRequest = { path: "/test", method: "GET", headers: {} };
  const sampleContext = {
    routerKind: "App Router" as const,
    routePath: "/test",
    routeType: "render" as const,
    revalidateReason: undefined,
  };

  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("vinext.instrumentation.state")];
    const mod = await import("../packages/vinext/src/server/instrumentation.js");
    runInstrumentation = mod.runInstrumentation;
    reportRequestError = mod.reportRequestError;
    const ctxMod = await import("../packages/vinext/src/shims/request-context.js");
    runWithExecutionContext = ctxMod.runWithExecutionContext;
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("vinext.instrumentation.state")];
    delete globalThis.__VINEXT_onRequestErrorHandler__;
  });

  it("calls the registered handler with correct args", async () => {
    const onRequestError = vi.fn();
    const runner = {
      import: vi.fn().mockResolvedValue({ onRequestError }),
    };
    await runInstrumentation(runner, "/fake/instrumentation.ts");

    const error = new Error("boom");
    await reportRequestError(error, sampleRequest, sampleContext);

    expect(onRequestError).toHaveBeenCalledWith(error, sampleRequest, sampleContext);
  });

  it("reports route patterns in Next.js format", async () => {
    const onRequestError = vi.fn();
    const runner = {
      import: vi.fn().mockResolvedValue({ onRequestError }),
    };
    await runInstrumentation(runner, "/fake/instrumentation.ts");

    await reportRequestError(new Error("boom"), sampleRequest, {
      ...sampleContext,
      routePath: "/blog/:slug/:rest+/:optional*",
    });

    expect(onRequestError.mock.calls[0]?.[2].routePath).toBe(
      "/blog/[slug]/[...rest]/[[...optional]]",
    );
  });

  it("no-ops when no handler is registered", async () => {
    // No runInstrumentation called, so _onRequestError is null.
    // Should not throw.
    await reportRequestError(new Error("boom"), sampleRequest, sampleContext);
  });

  it("catches and logs errors thrown by the handler", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onRequestError = vi.fn().mockRejectedValue(new Error("handler broke"));
    const runner = {
      import: vi.fn().mockResolvedValue({ onRequestError }),
    };
    await runInstrumentation(runner, "/fake/instrumentation.ts");

    await reportRequestError(new Error("boom"), sampleRequest, sampleContext);

    expect(consoleSpy).toHaveBeenCalledWith(
      "[vinext] onRequestError handler threw:",
      "handler broke",
    );
    consoleSpy.mockRestore();
  });

  it("registers the report promise with ctx.waitUntil on Workers", async () => {
    const onRequestError = vi.fn().mockResolvedValue(undefined);
    const runner = {
      import: vi.fn().mockResolvedValue({ onRequestError }),
    };
    await runInstrumentation(runner, "/fake/instrumentation.ts");

    const waitUntil = vi.fn();
    const ctx = { waitUntil };

    await runWithExecutionContext(ctx, () =>
      reportRequestError(new Error("boom"), sampleRequest, sampleContext),
    );

    expect(waitUntil).toHaveBeenCalledOnce();
    // The promise passed to waitUntil should resolve (reportRequestError never rejects)
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
  });

  it("does not call waitUntil when no execution context is available", async () => {
    const onRequestError = vi.fn().mockResolvedValue(undefined);
    const runner = {
      import: vi.fn().mockResolvedValue({ onRequestError }),
    };
    await runInstrumentation(runner, "/fake/instrumentation.ts");

    // Call outside runWithExecutionContext — should not throw
    await reportRequestError(new Error("boom"), sampleRequest, sampleContext);

    expect(onRequestError).toHaveBeenCalledOnce();
  });

  it("lets real @sentry/nextjs captureRequestError flush through Workers waitUntil", async () => {
    const envelopes: unknown[] = [];

    Sentry.init({
      dsn: "http://public@sentry.test/42",
      defaultIntegrations: false,
      tracesSampleRate: 0,
      transport: () => ({
        send(envelope: unknown) {
          envelopes.push(envelope);
          return Promise.resolve({});
        },
        flush() {
          return Promise.resolve(true);
        },
      }),
    });

    globalThis.__VINEXT_onRequestErrorHandler__ = Sentry.captureRequestError;
    const waitUntil = vi.fn();
    const ctx = { waitUntil };

    const cases = [
      {
        error: new Error("Server component error"),
        request: { path: "/error-server-test", method: "GET", headers: {} },
        context: {
          routerKind: "App Router" as const,
          routePath: "/error-server-test",
          routeType: "render" as const,
          revalidateReason: undefined,
        },
      },
      {
        error: new Error("Pages API error"),
        request: { path: "/api/error-route", method: "GET", headers: {} },
        context: {
          routerKind: "Pages Router" as const,
          routePath: "/api/error-route",
          routeType: "route" as const,
          revalidateReason: undefined,
        },
      },
      {
        error: new Error("Proxy error"),
        request: { path: "/proxy-error", method: "GET", headers: {} },
        context: {
          routerKind: "Pages Router" as const,
          routePath: "/proxy",
          routeType: "proxy" as const,
          revalidateReason: undefined,
        },
      },
    ];

    for (const testCase of cases) {
      await runWithExecutionContext(ctx, () =>
        reportRequestError(testCase.error, testCase.request, testCase.context),
      );
    }

    expect(waitUntil).toHaveBeenCalledTimes(6);
    await Promise.all(waitUntil.mock.calls.map(([promise]) => promise));

    const events = envelopes.flatMap(parseSentryEnvelopeEvents);
    expect(events.map((event) => event.exception?.values?.[0]?.value)).toEqual([
      "Server component error",
      "Pages API error",
      "Proxy error",
    ]);
    expect(events.map((event) => event.contexts?.nextjs)).toEqual([
      {
        request_path: "/error-server-test",
        router_kind: "App Router",
        router_path: "/error-server-test",
        route_type: "render",
      },
      {
        request_path: "/api/error-route",
        router_kind: "Pages Router",
        router_path: "/api/error-route",
        route_type: "route",
      },
      {
        request_path: "/proxy-error",
        router_kind: "Pages Router",
        router_path: "/proxy",
        route_type: "proxy",
      },
    ]);

    await (
      Sentry as unknown as { default?: { close?: (timeout?: number) => Promise<boolean> } }
    ).default?.close?.(0);
  });
});

describe("Sentry Next.js internal compatibility", () => {
  it("aliases Sentry's .js Next async-storage internals to vinext shims", async () => {
    await withInjectClientServer({ instrumentationClientInject: [] }, async ({ container }) => {
      const sentryAsyncStorageImports = [
        "next/dist/client/components/request-async-storage.js",
        "next/dist/client/components/request-async-storage.external.js",
        "next/dist/server/app-render/work-unit-async-storage.external.js",
        "next/dist/client/components/work-unit-async-storage.external.js",
      ];

      for (const id of sentryAsyncStorageImports) {
        const resolved = await container.resolveId(id);
        expect(toSlash(resolved?.id ?? "")).toContain(
          "/packages/vinext/src/shims/internal/work-unit-async-storage",
        );
      }
    });
  });
});

// Ported from Next.js: packages/next/src/build/webpack/loaders/next-instrumentation-client-loader.ts
// https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack/loaders/next-instrumentation-client-loader.ts
describe("instrumentationClientInject plugin pipeline", () => {
  const INJECT_A = `export function onRouterTransitionStart() {
  globalThis.__injectOrder = globalThis.__injectOrder ?? [];
  globalThis.__injectOrder.push("a");
}
`;
  const INJECT_B = `export function onRouterTransitionStart() {
  globalThis.__injectOrder = globalThis.__injectOrder ?? [];
  globalThis.__injectOrder.push("b");
}
`;
  const USER_CLIENT = `export function onRouterTransitionStart() {
  globalThis.__injectOrder = globalThis.__injectOrder ?? [];
  globalThis.__injectOrder.push("user");
}
`;
  const SIDE_EFFECT_ONLY = "globalThis.__sideEffect = true;\n";

  it("does not intercept private-next-instrumentation-client when injects is empty", async () => {
    await withInjectClientServer(
      { instrumentationClientInject: [], userClientSource: USER_CLIENT },
      async ({ container }) => {
        const resolved = await container.resolveId("private-next-instrumentation-client");
        expect(resolved).toBeTruthy();
        expect(resolved!.id).not.toBe(RESOLVED_INSTRUMENTATION_CLIENT);
        expect(toSlash(resolved!.id)).toContain("instrumentation-client.js");
      },
    );
  });

  it("falls back to empty-module fallback when injects is empty and no user file exists", async () => {
    await withInjectClientServer({ instrumentationClientInject: [] }, async ({ container }) => {
      const resolved = await container.resolveId("private-next-instrumentation-client");
      expect(resolved).toBeTruthy();
      expect(resolved!.id).not.toBe(RESOLVED_INSTRUMENTATION_CLIENT);
      expect(toSlash(resolved!.id)).toContain("empty-module");
    });
  });

  it("serves and composes the virtual module in inject order", async () => {
    await withInjectClientServer(
      {
        instrumentationClientInject: ["./inject-a.js", "./inject-b.js"],
        injectFiles: { "inject-a.js": INJECT_A, "inject-b.js": INJECT_B },
        userClientSource: USER_CLIENT,
      },
      async ({ tmpDir, container }) => {
        const resolved = await container.resolveId("private-next-instrumentation-client");
        expect(resolved?.id).toBe(RESOLVED_INSTRUMENTATION_CLIENT);

        const code = getLoadedCode(await container.load(resolved!.id));
        expect(code.indexOf("inject-a.js")).toBeGreaterThanOrEqual(0);
        expect(code.lastIndexOf("inject-b.js")).toBeGreaterThan(code.indexOf("inject-a.js"));
        expect(code.indexOf("import * as __vinj_2 from")).toBeGreaterThan(
          code.lastIndexOf("inject-b.js"),
        );
        expect(code).toContain("export function onRouterTransitionStart(url, type)");

        const entryPath = path.join(tmpDir, ".vinext-composed-instrumentation-client.mjs");
        fs.writeFileSync(entryPath, code);
        delete (globalThis as { __injectOrder?: string[] }).__injectOrder;
        // Node's ESM loader permanently caches imports based on their URL. Since integration
        // tests reuse temporary workspace directories, we use a cache-busting query parameter
        // to force Node to load the newly generated virtual module instead of a stale cached version.
        const mod = (await import(
          pathToFileURL(entryPath).href + `?t=${Date.now()}-${Math.random()}`
        )) as {
          onRouterTransitionStart?: (url: string, type: string) => void;
        };
        mod.onRouterTransitionStart?.("/x", "push");
        expect((globalThis as { __injectOrder?: string[] }).__injectOrder).toEqual([
          "a",
          "b",
          "user",
        ]);
      },
    );
  });

  it("allows side-effect-only inject modules without onRouterTransitionStart", async () => {
    await withInjectClientServer(
      {
        instrumentationClientInject: ["./inject-side.js"],
        injectFiles: { "inject-side.js": SIDE_EFFECT_ONLY },
      },
      async ({ tmpDir, container }) => {
        const resolved = await container.resolveId("private-next-instrumentation-client");
        const entryPath = path.join(tmpDir, ".vinext-composed-instrumentation-client.mjs");
        fs.writeFileSync(entryPath, getLoadedCode(await container.load(resolved!.id)));

        delete (globalThis as { __sideEffect?: boolean }).__sideEffect;
        // Node's ESM loader permanently caches imports based on their URL. Since integration
        // tests reuse temporary workspace directories, we use a cache-busting query parameter
        // to force Node to load the newly generated virtual module instead of a stale cached version.
        const mod = (await import(
          pathToFileURL(entryPath).href + `?t=${Date.now()}-${Math.random()}`
        )) as {
          onRouterTransitionStart?: (url: string, type: string) => void;
        };
        expect((globalThis as { __sideEffect?: boolean }).__sideEffect).toBe(true);
        expect(() => mod.onRouterTransitionStart?.("/x", "push")).not.toThrow();
      },
    );
  });
});

describe("generateInstrumentationClientInjectModule", () => {
  it("returns passthrough when injects is empty (userPath ignored)", () => {
    expect(generateInstrumentationClientInjectModule([], null)).toBe("export {};");
    expect(
      generateInstrumentationClientInjectModule([], "/project/instrumentation-client.ts"),
    ).toBe("export {};");
  });

  it("generates a single import for one inject entry", () => {
    const code = generateInstrumentationClientInjectModule(["./inject-a.js"], null);
    expect(code).toContain('import * as __vinj_0 from "./inject-a.js"');
    expect(code).toContain("export function onRouterTransitionStart(url, type)");
    expect(code).toContain('typeof __vinj_0.onRouterTransitionStart === "function"');
    expect(code).toContain("\n    __vinj_0.onRouterTransitionStart(url, type);\n");
  });

  it("generates imports in config order with user file last", () => {
    const code = generateInstrumentationClientInjectModule(
      ["./inject-a.js", "some-npm-pkg"],
      "/project/instrumentation-client.ts",
    );
    expect(code).toContain('import * as __vinj_0 from "./inject-a.js"');
    expect(code).toContain('import * as __vinj_1 from "some-npm-pkg"');
    expect(code).toContain('import * as __vinj_2 from "/project/instrumentation-client.ts"');
  });

  it("falls back to empty-module when user file is absent", () => {
    const code = generateInstrumentationClientInjectModule(["./inject-a.js"], null);
    expect(code).toContain("import * as __vinj_1 from");
    expect(code).toContain("empty-module");
  });

  it("composes hook calls for every module in array order", () => {
    const code = generateInstrumentationClientInjectModule(
      ["./inject-a.js", "./inject-b.js"],
      "/project/instrumentation-client.ts",
    );
    expect(code).toContain('typeof __vinj_0.onRouterTransitionStart === "function"');
    expect(code).toContain("__vinj_0.onRouterTransitionStart(url, type)");
    expect(code).toContain('typeof __vinj_1.onRouterTransitionStart === "function"');
    expect(code).toContain("__vinj_1.onRouterTransitionStart(url, type)");
    expect(code).toContain('typeof __vinj_2.onRouterTransitionStart === "function"');
    expect(code).toContain("__vinj_2.onRouterTransitionStart(url, type)");
  });

  it("escapes special characters in specifier paths", () => {
    const code = generateInstrumentationClientInjectModule(['./path/with"quote.js'], null);
    expect(code).toContain('from "./path/with\\"quote.js"');
  });
});
