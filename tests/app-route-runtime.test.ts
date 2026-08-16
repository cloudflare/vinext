import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createAppRouteRuntimeFingerprint,
  resolveAppRouteBuildRuntime,
} from "../packages/vinext/src/build/app-route-runtime.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createRouteFiles(files: Record<string, string>): Promise<{
  root: string;
  paths: Record<string, string>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-app-route-runtime-"));
  roots.push(root);
  const paths: Record<string, string> = {};
  for (const [name, source] of Object.entries(files)) {
    const filePath = path.join(root, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, source);
    paths[name] = filePath;
  }
  return { root, paths };
}

function route(overrides: Partial<AppRoute>): AppRoute {
  return {
    pattern: "/",
    pagePath: null,
    routePath: null,
    layouts: [],
    templates: [],
    parallelSlots: [],
    siblingIntercepts: [],
    loadingPath: null,
    errorPath: null,
    layoutErrorPaths: [],
    notFoundPath: null,
    notFoundPaths: [],
    forbiddenPaths: [],
    forbiddenPath: null,
    unauthorizedPath: null,
    unauthorizedPaths: [],
    routeSegments: [],
    layoutTreePositions: [],
    rootParamNames: [],
    isDynamic: false,
    params: [],
    patternParts: [],
    ...overrides,
  };
}

function parallelSlot(
  overrides: Partial<AppRoute["parallelSlots"][number]>,
): AppRoute["parallelSlots"][number] {
  return {
    key: "slot-key",
    name: "panel",
    ownerDir: "/app/@panel",
    ownerTreePath: "root",
    hasPage: true,
    pagePath: null,
    defaultPath: null,
    layoutPath: null,
    loadingPath: null,
    errorPath: null,
    interceptingRoutes: [],
    layoutIndex: 0,
    routeSegments: [],
    ...overrides,
  };
}

describe("App route build runtime", () => {
  it("changes the route fingerprint only when the effective runtime changes", async () => {
    const { paths } = await createRouteFiles({
      "page.tsx": `export default function Page() { return "first" }`,
    });
    const routes = [route({ pagePath: paths["page.tsx"] })];
    const nodeFingerprint = createAppRouteRuntimeFingerprint(routes);

    await fs.writeFile(
      paths["page.tsx"],
      `export default function Page() { return "ordinary HMR edit" }`,
    );
    expect(createAppRouteRuntimeFingerprint(routes)).toBe(nodeFingerprint);

    await fs.writeFile(
      paths["page.tsx"],
      `export const runtime = "edge"; export default function Page() { return "edge" }`,
    );
    expect(createAppRouteRuntimeFingerprint(routes)).not.toBe(nodeFingerprint);
  });

  it("extracts static runtime exports without matching comments or strings", async () => {
    const { paths } = await createRouteFiles({
      "layout.tsx": `
        // export const runtime = "edge"
        const example = 'export const runtime = "edge"'
        export default function Layout({ children }) { return children }
      `,
      "page.tsx": `
        export const runtime = \`edge\` satisfies "edge" | "nodejs"
        export default function Page() { return null }
      `,
    });

    expect(
      resolveAppRouteBuildRuntime(
        route({ layouts: [paths["layout.tsx"]], pagePath: paths["page.tsx"] }),
      ),
    ).toBe("edge");
  });

  it("extracts MDX ESM runtime exports without matching fenced examples", async () => {
    const { paths } = await createRouteFiles({
      "edge.mdx": `export const runtime =
  "edge"

# Edge content
`,
      "example.mdx": `# Runtime documentation

\`\`\`tsx
export const runtime = "edge"
\`\`\`
`,
    });

    expect(resolveAppRouteBuildRuntime(route({ pagePath: paths["edge.mdx"] }))).toBe("edge");
    expect(resolveAppRouteBuildRuntime(route({ pagePath: paths["example.mdx"] }))).toBe("nodejs");
  });

  it("does not inherit layout runtime for route handlers", async () => {
    const { paths } = await createRouteFiles({
      "layout.tsx": `export const runtime = "edge"`,
      "route.ts": `export function GET() { return new Response("ok") }`,
    });

    expect(
      resolveAppRouteBuildRuntime(
        route({ layouts: [paths["layout.tsx"]], routePath: paths["route.ts"] }),
      ),
    ).toBe("nodejs");
  });

  it("uses an active parallel-slot runtime when the primary branch has none", async () => {
    const { paths } = await createRouteFiles({
      "layout.tsx": `export default function Layout({ children }) { return children }`,
      "page.tsx": `export default function Page() { return null }`,
      "@panel/layout.tsx": `export default function Layout({ children }) { return children }`,
      "@panel/nested/layout.tsx": `export const runtime = "edge"`,
      "@panel/nested/page.tsx": `export default function Page() { return null }`,
    });

    expect(
      resolveAppRouteBuildRuntime(
        route({
          layouts: [paths["layout.tsx"]],
          pagePath: paths["page.tsx"],
          parallelSlots: [
            parallelSlot({
              layoutPath: paths["@panel/layout.tsx"],
              configLayoutPaths: [paths["@panel/nested/layout.tsx"]],
              pagePath: paths["@panel/nested/page.tsx"],
            }),
          ],
        }),
      ),
    ).toBe("edge");
  });

  it("keeps an explicit primary runtime authoritative over parallel slots", async () => {
    const { paths } = await createRouteFiles({
      "layout.tsx": `export default function Layout({ children }) { return children }`,
      "page.tsx": `export const runtime = "nodejs"`,
      "@panel/page.tsx": `export const runtime = "edge"`,
    });

    expect(
      resolveAppRouteBuildRuntime(
        route({
          layouts: [paths["layout.tsx"]],
          pagePath: paths["page.tsx"],
          parallelSlots: [parallelSlot({ pagePath: paths["@panel/page.tsx"] })],
        }),
      ),
    ).toBe("nodejs");
  });
});
