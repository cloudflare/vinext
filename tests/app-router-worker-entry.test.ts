import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

describe("App Router Production server worker entry compatibility", () => {
  it("accepts Worker-style default exports from dist/server/index.js", async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prod-worker-entry-"));
    const serverDir = path.join(outDir, "server");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.mkdirSync(path.join(outDir, "client"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(
      path.join(serverDir, "index.js"),
      `
export default {
  async fetch(request, _env, ctx) {
    ctx?.waitUntil(Promise.resolve("background"));
    return new Response(
      JSON.stringify({
        pathname: new URL(request.url).pathname,
        hasWaitUntil: typeof ctx?.waitUntil === "function",
        revalidateOrigin: ctx?.revalidateOrigin,
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
};
`,
    );

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({ port: 0, outDir, noCompression: true });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const res = await fetch(`http://localhost:${port}/worker-test`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        pathname: "/worker-test",
        hasWaitUntil: true,
      });
      const revalidateOrigin = new URL(body.revalidateOrigin);
      expect(revalidateOrigin.protocol).toBe("http:");
      expect(revalidateOrigin.port).toBe(String(port));
    } finally {
      server.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("preserves the trusted origin through wrappers that replace ctx", async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prod-worker-wrapped-"));
    const serverDir = path.join(outDir, "server");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.mkdirSync(path.join(outDir, "client"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(
      path.join(serverDir, "index.js"),
      `
import { getRequestExecutionContext, runWithExecutionContext } from ${JSON.stringify(
        pathToFileURL(
          path.join(import.meta.dirname, "../packages/vinext/dist/shims/request-context.js"),
        ).href,
      )};

async function handler() {
  return Response.json({
    revalidateOrigin: getRequestExecutionContext()?.revalidateOrigin,
  });
}

export default {
  fetch(request, env, ctx) {
    const replacementCtx = {
      waitUntil: ctx.waitUntil.bind(ctx),
    };
    return runWithExecutionContext(replacementCtx, () => handler(request, env));
  },
};
`,
    );

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({ port: 0, outDir, noCompression: true });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const response = await fetch(`http://localhost:${port}/wrapped`);
      const body = await response.json();
      expect(new URL(body.revalidateOrigin).port).toBe(String(port));
    } finally {
      server.close();
      fs.rmSync(outDir, { recursive: true, force: true });
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
