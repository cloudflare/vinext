import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";
import {
  findInstrumentationClientFile,
  findInstrumentationFile,
} from "../packages/vinext/src/server/instrumentation.js";
import { generateInstrumentationClientInjectModule } from "../packages/vinext/src/client/instrumentation-client-inject.js";
import { createValidFileMatcher } from "../packages/vinext/src/routing/file-matcher.js";

const RESOLVED_INSTRUMENTATION_CLIENT = "\0private-next-instrumentation-client.mjs";
const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "..", "node_modules");

function getLoadedCode(loaded: unknown): string {
  return typeof loaded === "string" ? loaded : ((loaded as { code?: string })?.code ?? "");
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

describe("findInstrumentationFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-instr-"));
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the path when a file exists at root", () => {
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), "");

    const result = findInstrumentationFile(tmpDir, createValidFileMatcher());

    expect(result).toBe(path.join(tmpDir, "instrumentation.ts"));
  });

  it("prefers root over src/ directory (priority order)", () => {
    // Create both root and src/ variants
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), "");
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "instrumentation.ts"), "");

    const result = findInstrumentationFile(tmpDir, createValidFileMatcher());

    // Root files come first in INSTRUMENTATION_FILES, so root wins
    expect(result).toBe(path.join(tmpDir, "instrumentation.ts"));
  });

  it("falls back to src/ directory", () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "instrumentation.ts"), "");

    const result = findInstrumentationFile(tmpDir, createValidFileMatcher());

    expect(result).toBe(path.join(tmpDir, "src", "instrumentation.ts"));
  });

  it("returns null when no instrumentation file exists", () => {
    const result = findInstrumentationFile(tmpDir, createValidFileMatcher());

    expect(result).toBeNull();
  });
});

describe("findInstrumentationClientFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-instr-client-"));
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the path when a file exists at root", () => {
    fs.writeFileSync(path.join(tmpDir, "instrumentation-client.ts"), "");

    const result = findInstrumentationClientFile(tmpDir, createValidFileMatcher());

    expect(result).toBe(path.join(tmpDir, "instrumentation-client.ts"));
  });

  it("prefers root over src/ directory (priority order)", () => {
    fs.writeFileSync(path.join(tmpDir, "instrumentation-client.ts"), "");
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "instrumentation-client.ts"), "");

    const result = findInstrumentationClientFile(tmpDir, createValidFileMatcher());

    expect(result).toBe(path.join(tmpDir, "instrumentation-client.ts"));
  });

  it("falls back to src/ directory", () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "instrumentation-client.ts"), "");

    const result = findInstrumentationClientFile(tmpDir, createValidFileMatcher());

    expect(result).toBe(path.join(tmpDir, "src", "instrumentation-client.ts"));
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
    const mod = await import("../packages/vinext/src/server/instrumentation.js");
    runInstrumentation = mod.runInstrumentation;
    getOnRequestErrorHandler = mod.getOnRequestErrorHandler;
  });

  afterEach(() => {
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

  it("logs error and continues when import fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runner = {
      import: vi.fn().mockRejectedValue(new Error("Module not found")),
    };

    // Should not throw
    await runInstrumentation(runner, "/fake/instrumentation.ts");

    expect(consoleSpy).toHaveBeenCalledWith(
      "[vinext] Failed to load instrumentation:",
      "Module not found",
    );
    consoleSpy.mockRestore();
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
  };

  beforeEach(async () => {
    vi.resetModules();
    delete globalThis.__VINEXT_onRequestErrorHandler__;
    delete process.env.VINEXT_PRERENDER;
    const mod = await import("../packages/vinext/src/server/instrumentation-runtime.js");
    ensureInstrumentationRegistered = mod.ensureInstrumentationRegistered;
    const instMod = await import("../packages/vinext/src/server/instrumentation.js");
    reportRequestError = instMod.reportRequestError;
  });

  afterEach(() => {
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
  };

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../packages/vinext/src/server/instrumentation.js");
    runInstrumentation = mod.runInstrumentation;
    reportRequestError = mod.reportRequestError;
    const ctxMod = await import("../packages/vinext/src/shims/request-context.js");
    runWithExecutionContext = ctxMod.runWithExecutionContext;
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
        expect(resolved!.id.replace(/\\/g, "/")).toContain("instrumentation-client.js");
      },
    );
  });

  it("falls back to empty-module fallback when injects is empty and no user file exists", async () => {
    await withInjectClientServer({ instrumentationClientInject: [] }, async ({ container }) => {
      const resolved = await container.resolveId("private-next-instrumentation-client");
      expect(resolved).toBeTruthy();
      expect(resolved!.id).not.toBe(RESOLVED_INSTRUMENTATION_CLIENT);
      expect(resolved!.id.replace(/\\/g, "/")).toContain("empty-module");
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
