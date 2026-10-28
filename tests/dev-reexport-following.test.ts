/**
 * Dev-server integration test: the RSC dev environment follows re-exports
 * through side-effect-free modules, so unused barrel leaves are not evaluated.
 *
 * Regression for https://github.com/cloudflare/vinext/issues/4007 in dev. A
 * Server Component imported one component from a `sideEffects: false` barrel
 * (`@heroui/react`). Vite dev does not tree-shake, so every leaf of the barrel
 * was evaluated in the RSC environment, and react-aria's module-scope
 * `createContext()` and `client-only` imports failed the request.
 *
 * Next.js (Turbopack) follows re-exports of side-effect-free modules in dev and
 * build, so only the modules that define the imported bindings are evaluated.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { startFixtureServer } from "./helpers.js";

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
 *   ui-barrel (index.js) ── re-exports ──> button.js      (server-safe, used)
 *                        ├─ re-exports ──> calendar.js    ("client-only" + module-scope createContext)
 *                        ├─ export * ───> menu.js         (module-scope createContext)
 *                        ├─ re-exports ──> client-card.js ("use client" re-export of client-card-impl.js)
 *                        └─ re-exports ──> toast.js ──> toast-queue.js
 *                                                        │ imports a binding
 *                                                        ▼ via "ui-primitives/toast"
 *   ui-primitives (sideEffects: ["*.css"]) toast.js ("client-only" + re-export
 *                                                    of queue.js's binding)
 */
function createFixture({ pageSource, sideEffects }: FixtureOptions): string {
  // Inside the repository so react, react-dom, and @vitejs/plugin-rsc resolve
  // from the workspace node_modules while the fixture's own node_modules
  // holds the barrel packages.
  const root = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-dev-reexport-following-"));
  tmpRoots.push(root);

  writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "dev-reexport-following", private: true, type: "module" }),
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
      exports: { ".": "./index.js" },
      ...(sideEffects === undefined ? {} : { sideEffects }),
    }),
  );
  writeFile(
    path.join(pkg, "index.js"),
    `export { Button } from "./button.js";
export { Calendar } from "./calendar.js";
export * from "./menu.js";
export { ClientCard } from "./client-card.js";
export { Toast } from "./toast.js";
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
import { createContext, createElement } from "react";
const CalendarContext = createContext(null);
export function Calendar() {
  return createElement(CalendarContext.Provider, { value: null }, "calendar");
}
`,
  );
  writeFile(
    path.join(pkg, "menu.js"),
    `import { createContext } from "react";
export const MenuContext = createContext(null);
export function Menu() {
  return null;
}
`,
  );
  writeFile(
    path.join(pkg, "client-card.js"),
    `"use client";
export { ClientCardImpl as ClientCard } from "./client-card-impl.js";
`,
  );
  writeFile(
    path.join(pkg, "client-card-impl.js"),
    `import { createElement, useState } from "react";
export function ClientCardImpl() {
  const [label] = useState("client card");
  return createElement("div", { "data-testid": "client-card" }, label);
}
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

  return root;
}

async function fetchDevPage(root: string): Promise<{ status: number; html: string }> {
  const { server, baseUrl } = await startFixtureServer(root);
  try {
    const response = await fetch(`${baseUrl}/`);
    return { status: response.status, html: await response.text() };
  } finally {
    await server.close();
  }
}

describe("dev re-export following in the RSC environment", () => {
  it("does not evaluate unused leaves of a sideEffects:false barrel", async () => {
    const root = createFixture({
      sideEffects: false,
      pageSource: `import { Button, ClientCard, Toast } from "ui-barrel";

export default function Page() {
  return (
    <main>
      <Button>ok</Button>
      <ClientCard />
      <Toast.Provider />
    </main>
  );
}
`,
    });

    const { status, html } = await fetchDevPage(root);
    expect(status).toBe(200);
    expect(html).toContain('data-testid="barrel-button"');
    expect(html).toContain('data-testid="toast-provider"');
    // Rendered as a client component: following stopped at the "use client"
    // module, so its implementation's useState() never ran in the RSC env.
    expect(html).toContain('data-testid="client-card"');
  }, 60_000);

  it("still fails when a used module of the barrel imports client-only", async () => {
    const root = createFixture({
      sideEffects: false,
      pageSource: `import { Calendar } from "ui-barrel";

export default function Page() {
  return <Calendar />;
}
`,
    });

    const { status, html } = await fetchDevPage(root);
    expect(status).toBe(500);
    expect(html).toContain("client-only");
  }, 60_000);

  it("evaluates the whole barrel when the package does not declare sideEffects: false", async () => {
    const root = createFixture({
      pageSource: `import { Button } from "ui-barrel";

export default function Page() {
  return <Button>ok</Button>;
}
`,
    });

    const { status } = await fetchDevPage(root);
    expect(status).toBe(500);
  }, 60_000);
});
