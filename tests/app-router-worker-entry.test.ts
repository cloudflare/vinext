import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

describe("App Router Production server worker entry compatibility", () => {
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
