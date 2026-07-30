import fs from "node:fs/promises";
import path from "node:path";
import { getPluginApi } from "@vitejs/plugin-rsc";
import { toSlash } from "pathslash";
import { type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { startFixtureServer } from "./helpers.js";

describe("App route NEXT_RUNTIME development parity", () => {
  let root: string;
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-app-route-runtime-dev-"));
    await fs.writeFile(path.join(root, "package.json"), `{"type":"module"}`);
    await fs.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    await fs.mkdir(path.join(root, "app", "shared"), { recursive: true });
    await fs.mkdir(path.join(root, "app", "edge"), { recursive: true });
    await fs.mkdir(path.join(root, "app", "nodejs"), { recursive: true });
    await fs.writeFile(
      path.join(root, "app", "layout.tsx"),
      `export default function Layout({ children }) { return <html><body>{children}</body></html> }`,
    );
    await fs.writeFile(
      path.join(root, "app", "shared", "action-runtime.ts"),
      `export const dependencyRuntime = process.env.NEXT_RUNTIME`,
    );
    await fs.writeFile(
      path.join(root, "app", "shared", "actions.ts"),
      `
        "use server"
        import { dependencyRuntime } from "./action-runtime"
        export async function sharedAction(source = "form") {
          return source + ":" + process.env.NEXT_RUNTIME + ":" + dependencyRuntime
        }
      `,
    );
    await fs.writeFile(
      path.join(root, "app", "shared", "client.tsx"),
      `
        "use client"
        import { sharedAction } from "./actions"
        export function SharedClient() {
          return <form action={sharedAction}><button>run</button></form>
        }
      `,
    );
    await fs.writeFile(
      path.join(root, "app", "shared", "page.tsx"),
      `
        import { SharedClient } from "./client"
        export default function Page() { return <SharedClient /> }
      `,
    );
    await fs.writeFile(
      path.join(root, "app", "edge", "page.tsx"),
      `export const runtime = "edge"; export { default } from "../shared/page"`,
    );
    await fs.writeFile(
      path.join(root, "app", "nodejs", "page.tsx"),
      `export const runtime = "nodejs"; export { default } from "../shared/page"`,
    );

    ({ server, baseUrl } = await startFixtureServer(root, { appRouter: true }));
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("dispatches a client-imported shared action in the matched route runtime", async () => {
    const edgePage = await fetch(`${baseUrl}/edge`);
    expect(edgePage.status).toBe(200);
    await edgePage.arrayBuffer();

    const pluginApi = getPluginApi(server.config);
    const serverReferences = Object.values(pluginApi?.manager.serverReferenceMetaMap ?? {});
    const canonicalImportId = toSlash(path.join(root, "app", "shared", "actions.ts"));
    const canonicalAction = serverReferences.find(({ importId }) => importId === canonicalImportId);
    const edgeAction = serverReferences.find(
      ({ importId }) => importId === `${canonicalImportId}?__vinext_app_runtime=edge`,
    );

    expect(canonicalAction).toMatchObject({
      importId: canonicalImportId,
      referenceKey: "/app/shared/actions.ts",
    });
    expect(edgeAction).toMatchObject({
      importId: `${canonicalImportId}?__vinext_app_runtime=edge`,
      referenceKey: "/app/shared/actions.ts?__vinext_app_runtime=edge",
    });

    for (const [route, runtime] of [
      ["edge", "edge"],
      ["nodejs", "nodejs"],
    ] as const) {
      const response = await fetch(`${baseUrl}/${route}.rsc`, {
        method: "POST",
        headers: {
          Accept: "text/x-component",
          "Content-Type": "text/plain",
          Origin: baseUrl,
          RSC: "1",
          "x-rsc-action": `${canonicalAction!.referenceKey}#sharedAction`,
        },
        body: JSON.stringify(["client-import"]),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(`client-import:${runtime}:${runtime}`);
      expect(body).not.toContain(
        `client-import:${runtime === "edge" ? "nodejs:nodejs" : "edge:edge"}`,
      );
    }
  });
});
