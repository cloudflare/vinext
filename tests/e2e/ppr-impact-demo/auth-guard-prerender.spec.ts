import { expect, test } from "@playwright/test";
import fs from "node:fs";

type PrerenderRoute = { route: string; status: string; reason?: string; error?: string };

// A page that reads cookies() before its redirect(), unauthorized(),
// forbidden() or notFound() is dynamic in Next.js (`ƒ` in `next build`), and
// its generateStaticParams paths are not prerender errors.
test("skips an auth guard's generateStaticParams paths as dynamic", async () => {
  const { routes } = JSON.parse(
    fs.readFileSync("tests/fixtures/ppr-impact-demo/dist/server/vinext-prerender.json", "utf8"),
  ) as { routes: PrerenderRoute[] };
  const guarded = routes
    .filter((route) => route.route === "/:locale/auth-guard/:kind")
    .map(({ status, reason, error }) => ({ status, reason, error }));

  // Two locales from the layout, four kinds from the page.
  expect(guarded).toEqual(
    Array.from({ length: 8 }, () => ({ status: "skipped", reason: "dynamic", error: undefined })),
  );
});

test("renders an auth guard's special errors at request time", async ({ request }) => {
  for (const [kind, status] of [
    ["redirect", 307],
    ["unauthorized", 401],
    ["forbidden", 403],
    ["not-found", 404],
  ] as const) {
    const response = await request.get(`/en/auth-guard/${kind}`, { maxRedirects: 0 });
    expect(response.status(), kind).toBe(status);
    expect(response.headers()["cache-control"], kind).toContain("no-store");
    if (kind === "redirect") {
      expect(new URL(response.headers().location, "http://n").pathname).toBe("/en/blog/known");
    }

    const signedIn = await request.get(`/fr/auth-guard/${kind}`, {
      headers: { Cookie: "session=1" },
      maxRedirects: 0,
    });
    expect(signedIn.status(), kind).toBe(200);
    expect(await signedIn.text(), kind).toContain("Signed in (fr)");
  }
});
