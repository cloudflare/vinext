import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

async function loadUnifiedFetchHandler(root: string): Promise<string> {
  let server: ViteDevServer | undefined;
  try {
    server = await createServer({
      root,
      configFile: false,
      plugins: [vinext()],
      server: { port: 0 },
      logLevel: "silent",
    });

    const resolved = await server.pluginContainer.resolveId("virtual:vinext-worker-entry");
    expect(resolved?.id).toBe("\0virtual:vinext-worker-entry");

    const loaded = await server.pluginContainer.load(resolved!.id);
    return typeof loaded === "string" ? loaded : ((loaded as { code?: string })?.code ?? "");
  } finally {
    await server?.close();
  }
}

describe("unified Cloudflare fetch handler", () => {
  it("delegates App Router apps to the App Router worker entry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-fetch-handler-app-"));
    try {
      fs.mkdirSync(path.join(root, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "app/page.tsx"),
        "export default function Page() { return <div>app</div>; }\n",
      );

      await expect(loadUnifiedFetchHandler(root)).resolves.toBe(
        'export { default } from "vinext/server/app-router-entry";',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("delegates Pages Router apps to the Pages Router worker entry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-fetch-handler-pages-"));
    try {
      fs.mkdirSync(path.join(root, "pages"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "pages/index.tsx"),
        "export default function Page() { return <div>pages</div>; }\n",
      );

      await expect(loadUnifiedFetchHandler(root)).resolves.toBe(
        'export { default } from "vinext/server/pages-router-entry";',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
