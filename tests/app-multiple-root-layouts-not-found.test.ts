/**
 * With several root layouts, a route uses the not-found boundary of its own
 * root layout's tree. A route under a root layout without a not-found file
 * gets the built-in one, never another root layout's (issue #4304).
 *
 * Next.js has no multiple-root-layout not-found test. A real next@16 build of
 * this app answers with the same status codes and never shows the [locale]
 * not-found or its metadata outside the [locale] tree. Where the built-in
 * not-found renders differs: Next.js serves its error shell for a notFound()
 * call and its /_not-found page for a dynamicParams miss, while vinext renders
 * it inside the route's layouts, so these tests only check what is absent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { startFixtureServer } from "./helpers.js";

// Every studio and docs route is a catch-all, so it sorts after the [locale]
// routes and the route list starts in the [locale] tree, as in the issue.
const FILES: Record<string, string> = {
  "app/[locale]/layout.tsx": `export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return <html lang={locale} className="locale-root-layout"><body>{children}</body></html>;
}
`,
  "app/[locale]/page.tsx": `export default function Page() { return <p id="locale-page">locale page</p>; }
`,
  // Stands in for a not-found that needs its own root layout's params, like
  // one calling next-intl's useTranslations().
  "app/[locale]/not-found.tsx": `export const metadata = { title: "locale-not-found-title" };

export default function LocaleNotFound() {
  return <p id="locale-not-found">locale-not-found-marker</p>;
}
`,
  "app/[locale]/meta/page.tsx": `import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  notFound();
}

export default function Page() { return <p>locale meta page</p>; }
`,
  "app/studio/layout.tsx": `export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return <html className="studio-root-layout"><body>{children}</body></html>;
}
`,
  "app/studio/[[...tool]]/page.tsx": `import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function StudioPage({ params }: { params: Promise<{ tool?: string[] }> }) {
  const { tool } = await params;
  if (tool?.[0] === "missing") notFound();
  return <p id="studio-page">studio page</p>;
}
`,
  "app/studio/meta/[...id]/page.tsx": `import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  notFound();
}

export default function Page() { return <p>meta page</p>; }
`,
  // A third root layout, so no other route claims its dynamicParams misses.
  "app/docs/layout.tsx": `export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <html className="docs-root-layout"><body>{children}</body></html>;
}
`,
  "app/docs/[...slug]/page.tsx": `export const dynamicParams = false;

export function generateStaticParams() {
  return [{ slug: ["a"] }];
}

export default function Page() { return <p>docs page</p>; }
`,
  "app/studio/broken/[...id]/layout.tsx": `import { notFound } from "next/navigation";

export default function BrokenLayout(): React.ReactNode {
  notFound();
}
`,
  "app/studio/broken/[...id]/page.tsx": `import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  notFound();
}

export default function Page() { return <p>broken page</p>; }
`,
};

describe("multiple root layouts: not-found boundaries stay in their root layout's tree", () => {
  let root: string;
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-multi-root-not-found-"));
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "fixtures/app-basic/node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
    for (const [file, source] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), source);
    }
    ({ server, baseUrl } = await startFixtureServer(root));
    // Compile both trees before the timed requests.
    await fetch(`${baseUrl}/en`);
    await fetch(`${baseUrl}/studio`);
  }, 60000);

  afterAll(async () => {
    await server?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not render another root layout's not-found for a route without one", async () => {
    const res = await fetch(`${baseUrl}/studio`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("studio page");
    expect(html).not.toContain("locale-not-found");
  });

  it("does not put another root layout's not-found in the RSC payload", async () => {
    const res = await fetch(`${baseUrl}/studio.rsc`, { headers: { RSC: "1" } });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("locale-not-found");
  });

  it.each([
    ["a page calling notFound()", "/studio/missing", 404],
    // Its page's generateMetadata() calls notFound() too, so the 404's head
    // is recovered through the not-found convention.
    ["a layout calling notFound()", "/studio/broken/x", 404],
    // generateMetadata() streams, so its notFound() lands after the shell.
    ["generateMetadata() calling notFound()", "/studio/meta/x", 200],
    // A param outside generateStaticParams with dynamicParams = false.
    ["a dynamicParams = false miss", "/docs/b", 404],
  ])(
    "renders the built-in not-found, not another root layout's, for %s",
    async (_, pathname, status) => {
      const res = await fetch(`${baseUrl}${pathname}`);
      expect(res.status).toBe(status);
      const html = await res.text();
      expect(html).not.toContain("locale-not-found");
      expect(html).not.toContain("locale-root-layout");
      expect(html).toContain("This page could not be found.");
      // The built-in not-found has no metadata, so the recovered head adds no
      // title, as in Next.js. Only the built-in page's own title may render.
      expect(html).not.toMatch(/<title>(?!404: This page could not be found\.)/);
    },
  );

  it("keeps the [locale] not-found for the [locale] tree", async () => {
    const res = await fetch(`${baseUrl}/en`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("locale page");
    // The not-found boundary's fallback is part of the page's Flight payload.
    expect(html).toContain("locale-not-found-marker");
  });

  it("keeps the [locale] not-found head for the [locale] tree", async () => {
    const res = await fetch(`${baseUrl}/en/meta`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>locale-not-found-title</title>");
  });
});
