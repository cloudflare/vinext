import { describe, expect, it } from "vite-plus/test";
import {
  PRERENDER_WORKERD_LOADER_SOURCE,
  PRERENDER_WORKERD_STUB_SOURCE,
  registerPrerenderWorkerdStubs,
} from "../packages/vinext/src/server/prerender-workerd-stubs.js";

/**
 * The hooks/stub modules are standalone sources, so they load like they do in the loader
 * thread. Static imports cannot work here: the specifier is a data: URL built at runtime
 * from an in-memory string.
 */
function dataUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

const STUB_URL_PREFIX = "vinext-workerd-stub:";
const UNAVAILABLE = /cloudflare:workers .*unavailable while prerendering/;

describe("prerender workerd loader hooks", () => {
  it("short-circuits cloudflare: specifiers to the stub module", async () => {
    const loader = await import(dataUrl(PRERENDER_WORKERD_LOADER_SOURCE));
    const nextResolve = () => {
      throw new Error("nextResolve must not be called for cloudflare: specifiers");
    };
    const nextLoad = () => {
      throw new Error("nextLoad must not be called for stub URLs");
    };

    for (const specifier of ["cloudflare:workers", "cloudflare:sockets"]) {
      const resolved = await loader.resolve(specifier, { conditions: ["node"] }, nextResolve);
      expect(resolved.format).toBe("module");
      expect(resolved.shortCircuit).toBe(true);
      expect(resolved.url.startsWith(STUB_URL_PREFIX)).toBe(true);

      const loaded = await loader.load(resolved.url, {}, nextLoad);
      expect(loaded.format).toBe("module");
      expect(loaded.shortCircuit).toBe(true);
      expect(loaded.source).toBe(PRERENDER_WORKERD_STUB_SOURCE);
    }
  });

  it("passes non-cloudflare specifiers through to nextResolve", async () => {
    const loader = await import(dataUrl(PRERENDER_WORKERD_LOADER_SOURCE));
    const calls: Array<{ specifier: string; context: unknown }> = [];
    const context = { conditions: ["node"] };
    const passthrough = { url: "file:///app/local.js", format: "module", shortCircuit: true };
    const nextResolve = async (specifier: string, passed: unknown) => {
      calls.push({ specifier, context: passed });
      return passthrough;
    };

    await expect(loader.resolve("./local.js", context, nextResolve)).resolves.toBe(passthrough);
    expect(calls).toEqual([{ specifier: "./local.js", context }]);
  });
});

describe("prerender workerd stub module", () => {
  it("throws a descriptive error when a binding is read", async () => {
    const stub = await import(dataUrl(PRERENDER_WORKERD_STUB_SOURCE));

    expect(() => stub.env.MY_BUCKET).toThrow(UNAVAILABLE);
  });

  it("stays inert for probes, scoped helpers, and namespaces", async () => {
    const stub = await import(dataUrl(PRERENDER_WORKERD_STUB_SOURCE));

    const awaitedEnv = await stub.env;
    expect(awaitedEnv).toBe(stub.env);
    expect(typeof stub.env).toBe("object");
    expect(() => JSON.stringify({ env: stub.env })).not.toThrow();
    expect(stub.waitUntil(Promise.resolve())).toBeUndefined();
    expect(stub.withEnv({}, () => "x")).toBe("x");
  });

  it("exports the surface of cloudflare:workers", async () => {
    const stub = await import(dataUrl(PRERENDER_WORKERD_STUB_SOURCE));

    for (const name of [
      "env",
      "exports",
      "cache",
      "tracing",
      "waitUntil",
      "withEnv",
      "withExports",
      "withEnvAndExports",
      "RpcTarget",
      "RpcStub",
      "WorkerEntrypoint",
      "DurableObject",
      "WorkflowStep",
      "WorkflowEntrypoint",
    ]) {
      expect(stub[name]).toBeDefined();
    }
  });
});

describe("registerPrerenderWorkerdStubs", () => {
  it("is idempotent", () => {
    expect(registerPrerenderWorkerdStubs()).toBeUndefined();
    expect(registerPrerenderWorkerdStubs()).toBeUndefined();
  });
});
