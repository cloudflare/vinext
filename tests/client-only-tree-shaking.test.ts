/**
 * Build-time integration test: a `client-only` marker that tree-shaking drops
 * from the RSC graph must not fail the build.
 *
 * Regression for https://github.com/cloudflare/vinext/issues/4007. A Server
 * Component imported one component from a `sideEffects: false` barrel
 * (`@heroui/react`). An unused leaf of that barrel (react-aria-components'
 * `Calendar`) imports `client-only`, and @vitejs/plugin-rsc's
 * `rsc:validate-imports` walked the pre-tree-shaking module graph, so the
 * build failed even though the marker never reached the output.
 *
 * Next.js (Turbopack) resolves `client-only` in the server graph to an import
 * error that is only reported when the importing module stays in the
 * tree-shaken module graph:
 *   crates/next-core/src/next_import_map.rs (insert_client_only_error_alias)
 */
import fs from "node:fs";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const tmpRoots: string[] = [];

afterAll(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

function writeFile(file: string, source: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}

type FixtureOptions = {
  pageSource: string;
  /** `sideEffects` field of the barrel package. Omitted when undefined. */
  sideEffects?: boolean;
};

/**
 * Mirrors the graph from the issue:
 *
 *   ui-barrel (index.js) ── re-exports ──> button.js   (server-safe, used)
 *                        ├─ re-exports ──> calendar.js (imports "client-only")
 *                        └─ re-exports ──> toast.js ──> toast-queue.js
 *                                                        │ imports a binding
 *                                                        ▼ via "ui-primitives/toast"
 *   ui-primitives (sideEffects: ["*.css"]) toast.js ("client-only" + re-export
 *                                                    of queue.js's binding)
 *
 * `ui-primitives/toast` is the react-aria-components `Toast.mjs` shape: a
 * module in a package with a glob `sideEffects` list that imports
 * `client-only` but only re-exports a binding from elsewhere, so the marker
 * module is dropped even though the binding is used.
 *
 * `ui-barrel/legacy` is a separate CommonJS entry that requires `client-only`,
 * used only by the CommonJS case.
 */
function createFixture({ pageSource, sideEffects }: FixtureOptions): string {
  // Inside the repository so react, react-dom, and @vitejs/plugin-rsc resolve
  // from the workspace node_modules while the fixture's own node_modules
  // holds the barrel package.
  const root = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-client-only-tree-shaking-"));
  tmpRoots.push(root);

  writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "client-only-tree-shaking", private: true, type: "module" }),
  );
  writeFile(
    path.join(root, "app", "layout.tsx"),
    `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  );
  writeFile(path.join(root, "app", "page.tsx"), pageSource);

  const pkg = path.join(root, "node_modules", "ui-barrel");
  writeFile(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "ui-barrel",
      version: "1.0.0",
      type: "module",
      exports: { ".": "./index.js", "./legacy": "./legacy.cjs" },
      ...(sideEffects === undefined ? {} : { sideEffects }),
    }),
  );
  writeFile(
    path.join(pkg, "index.js"),
    `export { Button } from "./button.js";
export { Calendar } from "./calendar.js";
export { Toast } from "./toast.js";
`,
  );
  writeFile(
    path.join(pkg, "legacy.cjs"),
    `require("client-only");
exports.legacyLabel = "legacy";
`,
  );
  writeFile(
    path.join(pkg, "button.js"),
    `import { createElement } from "react";
export function Button(props) {
  return createElement("button", { "data-testid": "barrel-button" }, props.children);
}
`,
  );
  writeFile(
    path.join(pkg, "calendar.js"),
    `import "client-only";
import { createElement } from "react";
export function Calendar() {
  return createElement("div", null, "calendar");
}
`,
  );
  const primitives = path.join(root, "node_modules", "ui-primitives");
  writeFile(
    path.join(primitives, "package.json"),
    JSON.stringify({
      name: "ui-primitives",
      version: "1.0.0",
      type: "module",
      exports: { "./toast": "./toast.js" },
      sideEffects: ["*.css"],
    }),
  );
  writeFile(
    path.join(primitives, "queue.js"),
    `export class Queue {
  constructor() {
    this.items = [];
  }
}
`,
  );
  writeFile(
    path.join(primitives, "toast.js"),
    `import { Queue as ToastQueue } from "./queue.js";
import "client-only";
export { ToastQueue as Queue };
`,
  );
  writeFile(
    path.join(pkg, "toast-queue.js"),
    `import { Queue } from "ui-primitives/toast";
export const toastQueue = new Queue();
`,
  );
  writeFile(
    path.join(pkg, "toast.js"),
    `import { createElement } from "react";
import { toastQueue } from "./toast-queue.js";
function Provider() {
  return createElement("div", { "data-testid": "toast-provider" }, String(toastQueue.items.length));
}
export const Toast = { Provider };
`,
  );

  return root;
}

async function buildFixture(root: string): Promise<void> {
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [vinext({ appDir: root })],
    logLevel: "silent",
  });
  await builder.buildApp();
}

async function fetchPage(root: string): Promise<{ status: number; html: string }> {
  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const { server } = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir: path.join(root, "dist"),
    noCompression: true,
  });
  try {
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("server has no port");
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    return { status: response.status, html: await response.text() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("client-only in the RSC graph", () => {
  it("builds when tree-shaking drops every client-only marker of a sideEffects:false barrel", async () => {
    const root = createFixture({
      sideEffects: false,
      pageSource: `import { Button, Toast } from "ui-barrel";

export default function Page() {
  return (
    <main>
      <Button>ok</Button>
      <Toast.Provider />
    </main>
  );
}
`,
    });

    await buildFixture(root);

    const { status, html } = await fetchPage(root);
    expect(status).toBe(200);
    expect(html).toContain('data-testid="barrel-button"');
    expect(html).toContain('data-testid="toast-provider"');
  }, 120_000);

  it("fails when a used module of the barrel imports client-only", async () => {
    const root = createFixture({
      sideEffects: false,
      pageSource: `import { Calendar } from "ui-barrel";

export default function Page() {
  return <Calendar />;
}
`,
    });

    await expect(buildFixture(root)).rejects.toThrow(
      /'client-only' cannot be imported in server build \('rsc' environment\)[\s\S]*ui-barrel\/calendar\.js/,
    );
  }, 120_000);

  it("fails when a used CommonJS module requires client-only", async () => {
    const root = createFixture({
      sideEffects: false,
      pageSource: `import { legacyLabel } from "ui-barrel/legacy";

export default function Page() {
  return <main>{legacyLabel}</main>;
}
`,
    });

    await expect(buildFixture(root)).rejects.toThrow(
      /'client-only' cannot be imported in server build \('rsc' environment\)[\s\S]*ui-barrel\/legacy\.cjs/,
    );
  }, 120_000);

  it("names the retained dynamic import rather than a dropped barrel leaf", async () => {
    const root = createFixture({
      sideEffects: false,
      pageSource: `import { Button } from "ui-barrel";

export default async function Page() {
  await import("client-only");
  return <Button>ok</Button>;
}
`,
    });

    await expect(buildFixture(root)).rejects.toThrow(
      /'client-only' cannot be imported in server build \('rsc' environment\):\n imported by app\/page\.tsx\n/,
    );
  }, 120_000);

  it("fails when the barrel package does not declare sideEffects: false", async () => {
    const root = createFixture({
      pageSource: `import { Button } from "ui-barrel";

export default function Page() {
  return <Button>ok</Button>;
}
`,
    });

    await expect(buildFixture(root)).rejects.toThrow(
      /'client-only' cannot be imported in server build \('rsc' environment\)[\s\S]*ui-barrel\/calendar\.js/,
    );
  }, 120_000);

  it("fails when a Server Component imports client-only directly", async () => {
    const root = createFixture({
      sideEffects: false,
      pageSource: `import "client-only";

export default function Page() {
  return <main>direct</main>;
}
`,
    });

    await expect(buildFixture(root)).rejects.toThrow(
      /'client-only' cannot be imported in server build \('rsc' environment\)[\s\S]*app\/page\.tsx/,
    );
  }, 120_000);
});
