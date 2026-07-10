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
  expect(firstPage.headers()["x-nextjs-cache"]).toBe("MISS");
  const firstPageHtml = await firstPage.text();
  expect(firstPageHtml).toContain("Generated");
  expect(firstPageHtml).toContain(slug);

  const cachedPage = await request.get(pathname);
  expect(cachedPage.headers()["x-nextjs-cache"]).toBe("HIT");
});
