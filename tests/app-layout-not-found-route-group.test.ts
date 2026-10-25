/**
 * Next.js gives a first-layer route group the root segment's not-found when
 * the group has none of its own, so a layout's notFound() below the group
 * renders the 404 inside the group's layout. Guards the boundary selection
 * added for issue #4045.
 *
 * Based on Next.js test/e2e/app-dir/not-found-default
 * ("should render default not found for group routes if not found is not defined").
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { startFixtureServer } from "./helpers.js";

const THROWING_LAYOUT = `import { notFound } from "next/navigation";

export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (id === "404") notFound();
  return <div className="group-dynamic-layout">{children}</div>;
}
`;

const PAGE = `export const dynamic = "force-dynamic";

export default function Page() { return <p id="page">group-dynamic [id]</p>; }
`;

const APPS: {
  name: string;
  files: Record<string, string>;
  notFoundText: string;
  layoutClasses: string[];
}[] = [
  {
    name: "the built-in not-found below the root layout",
    files: {
      "app/layout.tsx": `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html className="root-layout-html"><body>{children}</body></html>;
}
`,
      "app/(group)/layout.tsx": `export default function GroupLayout({ children }: { children: React.ReactNode }) {
  return <div className="group-root-layout">{children}</div>;
}
`,
      "app/(group)/group-dynamic/[id]/layout.tsx": THROWING_LAYOUT,
      "app/(group)/group-dynamic/[id]/page.tsx": PAGE,
    },
    notFoundText: "This page could not be found.",
    layoutClasses: ["root-layout-html", "group-root-layout"],
  },
  {
    name: "app/not-found with the root layout in the group",
    files: {
      "app/not-found.tsx": `export default function NotFound() { return <p>Root not found</p>; }
`,
      "app/(group)/layout.tsx": `export default function GroupLayout({ children }: { children: React.ReactNode }) {
  return <html className="group-root-layout"><body>{children}</body></html>;
}
`,
      "app/(group)/group-dynamic/[id]/layout.tsx": THROWING_LAYOUT,
      "app/(group)/group-dynamic/[id]/page.tsx": PAGE,
    },
    notFoundText: "Root not found",
    layoutClasses: ["group-root-layout"],
  },
];

describe.each(APPS)("layout notFound() below a first-layer route group: $name", (app) => {
  let root: string;
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-group-not-found-"));
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "fixtures/app-basic/node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
    for (const [file, source] of Object.entries(app.files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), source);
    }
    ({ server, baseUrl } = await startFixtureServer(root));
  }, 60000);

  afterAll(async () => {
    await server?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("renders the page for a valid id", async () => {
    const res = await fetch(`${baseUrl}/group-dynamic/123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("group-dynamic [id]");
  });

  it("renders the 404 inside the layouts above the group's boundary", async () => {
    const res = await fetch(`${baseUrl}/group-dynamic/404`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain(app.notFoundText);
    for (const className of app.layoutClasses) {
      expect(html).toContain(`class="${className}"`);
    }
    expect(html).not.toContain("group-dynamic-layout");
  });
});
