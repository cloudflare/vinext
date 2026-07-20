import { expect, test } from "@playwright/test";

test("only-generated revalidation leaves an unseen blocking fallback path ungenerated", async ({
  request,
}) => {
  const slug = `dev-unseen-${Date.now()}`;
  const pathname = `/revalidate-only-generated/${slug}`;

  const revalidate = await request.get(
    `/api/revalidate-reason?path=${encodeURIComponent(pathname)}&onlyGenerated=1`,
  );
  expect(revalidate.status()).toBe(200);
  expect(await revalidate.json()).toEqual({ revalidated: true });

  const firstPage = await request.get(pathname);
  expect(firstPage.status()).toBe(200);
  expect(firstPage.headers()["x-nextjs-cache"]).toBe("HIT");
  expect(firstPage.headers()["x-vinext-cache"]).toBeUndefined();
  expect(firstPage.headers()["cache-control"]).toBe("no-cache, must-revalidate");
  const firstPageHtml = await firstPage.text();
  expect(firstPageHtml).toContain("Generated");
  expect(firstPageHtml).toContain(slug);
  expect(firstPageHtml).toContain('data-testid="generation">1</span>');

  const repeatedPage = await request.get(pathname);
  expect(repeatedPage.headers()["x-nextjs-cache"]).toBe("HIT");
  expect(repeatedPage.headers()["x-vinext-cache"]).toBeUndefined();
  expect(repeatedPage.headers()["cache-control"]).toBe("no-cache, must-revalidate");
  expect(await repeatedPage.text()).toContain('data-testid="generation">2</span>');
});

test("rejects nested and self-targeting dev revalidation", async ({ request }) => {
  const nested = await request.get(
    `/api/revalidate-reason?path=${encodeURIComponent("/api/nested-revalidate")}`,
  );
  expect(await nested.json()).toEqual({ revalidated: false });

  const startedAt = Date.now();
  const selfTarget = await request.get("/api/nested-revalidate?self=1");
  expect(await selfTarget.json()).toEqual({ nestedRejected: true });
  expect(Date.now() - startedAt).toBeLessThan(2_000);
});

test("does not reject forged revalidation-header presence in dev", async ({ request }) => {
  const response = await request.get("/api/nested-revalidate", {
    headers: { "x-prerender-revalidate": "forged" },
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ nestedRejected: false });
});
