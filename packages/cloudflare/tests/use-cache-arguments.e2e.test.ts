import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Miniflare } from "miniflare";
import { createBuilder, type PluginOption } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import vinext from "../../vinext/src/index.js";

const workspace = path.resolve(import.meta.dirname, "../../..");
const cfFixture = path.join(workspace, "tests/fixtures/cf-app-basic");

// Real workerd coverage is required: Flight's asynchronous Blob references
// can decode differently here than in Node's production build tests.
describe("use cache File identity and replay in Workers", () => {
  let root: string;
  let worker: Miniflare | undefined;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-cache-worker-"));
    await fs.mkdir(path.join(root, "app/api/check"), { recursive: true });
    await fs.symlink(
      path.join(cfFixture, "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await fs.writeFile(
      path.join(root, "next.config.mjs"),
      "export default {cacheComponents:true};",
    );
    await fs.writeFile(
      path.join(root, "wrangler.jsonc"),
      JSON.stringify({
        name: "vinext-cache-arguments",
        main: "vinext/server/fetch-handler",
        compatibility_date: "2026-02-12",
        compatibility_flags: ["nodejs_compat"],
        assets: { directory: "./dist/client" },
      }),
    );
    await fs.writeFile(
      path.join(root, "app/layout.tsx"),
      "export default function Root({children}) {return <html><body>{children}</body></html>}",
    );
    await fs.writeFile(
      path.join(root, "app/page.tsx"),
      "export default function Page(){return <p>File cache test</p>}",
    );
    await fs.copyFile(
      path.join(workspace, "tests/fixtures/app-basic/app/api/use-cache-arguments/route.ts"),
      path.join(root, "app/api/check/route.ts"),
    );
    const { cloudflare } = (await import(
      pathToFileURL(path.join(cfFixture, "node_modules/@cloudflare/vite-plugin/dist/index.mjs"))
        .href
    )) as {
      cloudflare: (options: {
        viteEnvironment: { name: string; childEnvironments: string[] };
      }) => PluginOption;
    };
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        vinext({ appDir: root }),
        cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
      ],
    });
    await builder.buildApp();
    const dist = path.join(root, "dist/server");
    const files = (await fs.readdir(dist, { recursive: true })).filter(
      (file) => file.endsWith(".js") && file !== "index.js",
    );
    worker = new Miniflare({
      compatibilityDate: "2026-02-12",
      compatibilityFlags: ["nodejs_compat"],
      modules: await Promise.all(
        ["index.js", ...files].map(async (file) => ({
          path: file,
          type: "ESModule" as const,
          contents: await fs.readFile(path.join(dist, file), "utf8"),
        })),
      ),
    });
  }, 120000);

  afterAll(async () => {
    await worker?.dispose();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function request(query: Record<string, string>) {
    if (!worker) throw new Error("Worker not started");
    const response = await worker.dispatchFetch(
      `https://test.local/api/check?${new URLSearchParams(query)}`,
    );
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      execution: number;
      value: unknown;
      hasReplay?: boolean;
      sameKey?: boolean;
      writes?: number;
      first: { execution: number; value: unknown };
      after: { execution: number; value: unknown };
    }>;
  }

  it.each([false, true])(
    "isolates files and reuses entries (attacker first: %s)",
    async (reverse) => {
      const base = { kind: "file", partition: `isolation-${reverse}` };
      const firstInput = { ...base, name: reverse ? "public.txt" : "private.txt" };
      const secondInput = { ...base, name: reverse ? "private.txt" : "public.txt" };
      const first = await request(firstInput);
      const second = await request(secondInput);
      expect(second.value).not.toEqual(first.value);
      expect(second.execution).not.toBe(first.execution);
      expect(await request(firstInput)).toEqual(first);
      const bytes = await request({ ...firstInput, text: "X" });
      expect(bytes.value).not.toEqual(first.value);
      expect(await request(firstInput)).toEqual(first);
    },
  );

  it.each([
    "file",
    "nested",
    "promise",
    "map-file",
    "set-file",
    "form-file",
    "shared-file",
    "shared-blob",
    "captured-file",
    "captured-rich",
    "blob",
    "bytes",
    "form-order",
    "promise-order",
    "byte-view",
    "data-view",
    "nested-view",
    "array-iterator",
    "augmented-promise",
    "shared-date",
    "invalid-date",
  ])("replays %s without losing metadata, identity, or cache hits", async (kind) => {
    const result = await request({ kind, partition: `replay-${kind}`, replay: "1", text: "ab" });
    expect(result.hasReplay).toBe(true);
    expect(result.sameKey).toBe(true);
    expect(result.writes).toBe(2);
    expect(result.after.value).toEqual(result.first.value);
    expect(result.after.execution).toBe(result.first.execution + 1);
  });

  it("isolates indexed array values when an iterator hides them", async () => {
    const base = { kind: "array-iterator", partition: "array-iterator" };
    const first = await request({ ...base, text: "private" });
    const second = await request({ ...base, text: "public" });
    expect(first.value).toEqual(["private"]);
    expect(second.value).toEqual(["public"]);
    expect(await request({ ...base, text: "private" })).toEqual(first);
  });

  it.each(["byte-view", "data-view"])(
    "normalizes %s and reuses its canonical entry",
    async (kind) => {
      const base = { kind, partition: `normalized-${kind}` };
      const first = await request(base);
      expect(first.value).toEqual({
        type: kind === "byte-view" ? "Uint8Array" : "DataView",
        offset: 0,
        bytes: [1],
      });
      expect(await request({ ...base, standalone: "1" })).toEqual(first);
    },
  );

  it("isolates the resolved File of augmented promises", async () => {
    const base = { kind: "augmented-promise", partition: "augmented-promise" };
    const first = await request({ ...base, name: "private.txt" });
    const second = await request({ ...base, name: "public.txt" });
    expect(second.value).not.toEqual(first.value);
    expect(second.execution).not.toBe(first.execution);
    expect(await request({ ...base, name: "private.txt" })).toEqual(first);
  });

  it("uses Flight completion order and reuses the same promise schedule", async () => {
    const base = { kind: "promise-order", partition: "timing" };
    const first = await request({ ...base, order: "forward" });
    const reverse = await request({ ...base, order: "reverse" });
    expect(reverse.value).toEqual(first.value);
    expect(reverse.execution).not.toBe(first.execution);
    expect(await request({ ...base, order: "forward" })).toEqual(first);
  });
});
