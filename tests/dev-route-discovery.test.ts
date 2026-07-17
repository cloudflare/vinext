import { afterEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { startFixtureServer } from "./helpers.js";

const tempDirs: string[] = [];
const servers: ViteDevServer[] = [];

async function createFixture(router: "app" | "pages"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `vinext-dev-${router}-routes-`));
  tempDirs.push(root);
  await fs.symlink(path.join(process.cwd(), "node_modules"), path.join(root, "node_modules"));

  if (router === "app") {
    await fs.mkdir(path.join(root, "app"), { recursive: true });
    await fs.writeFile(
      path.join(root, "app", "layout.tsx"),
      "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n",
    );
    await fs.writeFile(
      path.join(root, "app", "page.tsx"),
      "export default function Home() { return <p>App home</p>; }\n",
    );
  } else {
    await fs.mkdir(path.join(root, "pages"), { recursive: true });
    await fs.writeFile(
      path.join(root, "pages", "index.tsx"),
      "export default function Home() { return <p>Pages home</p>; }\n",
    );
  }

  return root;
}

async function start(root: string) {
  const result = await startFixtureServer(root);
  servers.push(result.server);
  return result;
}

async function stop(server: ViteDevServer) {
  const index = servers.indexOf(server);
  if (index !== -1) servers.splice(index, 1);
  await server.close();
}

async function writeNewRoute(root: string, router: "app" | "pages", text: string) {
  const routePath =
    router === "app"
      ? path.join(root, "app", "new", "page.tsx")
      : path.join(root, "pages", "new.tsx");
  await fs.mkdir(path.dirname(routePath), { recursive: true });
  await fs.writeFile(routePath, `export default function NewPage() { return <p>${text}</p>; }\n`);
}

async function expectRoute(baseUrl: string, route: string, text: string): Promise<void> {
  let lastStatus = 0;
  let lastResponse = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await fetch(`${baseUrl}${route}`);
    lastStatus = response.status;
    lastResponse = await response.text();
    if (response.status === 200 && lastResponse.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(lastStatus).toBe(200);
  expect(lastResponse).toContain(text);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe.each(["app", "pages"] as const)("%s router dev route discovery", (router) => {
  it("discovers a route added while the dev server is running", async () => {
    // Ported from Next.js:
    // test/development/read-only-source-hmr/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/development/read-only-source-hmr/test/index.test.ts
    // test/development/app-hmr/hmr.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/development/app-hmr/hmr.test.ts
    const root = await createFixture(router);
    const { server, baseUrl } = await start(root);
    expect((await fetch(`${baseUrl}/new`)).status).toBe(404);

    await writeNewRoute(root, router, `New ${router} route`);

    await expectRoute(baseUrl, "/new", `New ${router} route`);
    await stop(server);
  });

  it("discovers a route added between dev server instances", async () => {
    const root = await createFixture(router);
    const first = await start(root);
    expect((await fetch(`${first.baseUrl}/new`)).status).toBe(404);
    await stop(first.server);

    await writeNewRoute(root, router, `Restarted ${router} route`);

    const second = await start(root);
    await expectRoute(second.baseUrl, "/new", `Restarted ${router} route`);
    await stop(second.server);
  });
});
