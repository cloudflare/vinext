import path from "node:path";
import { test, expect } from "../../fixtures";

// Ported from Next.js:
// https://github.com/vercel/next.js/blob/2471a5068f2a312ea1ae84f7f5f65bf2e2331206/test/development/app-dir/next-image-lcp-duplicate-src/next-image-lcp-duplicate-src.test.ts
for (const mode of ["eager", "preload", "priority", "lazy"]) {
  test(`LCP warning inspects the painted ${mode} image rather than its duplicate`, async ({
    page,
    consoleErrors,
  }, testInfo) => {
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
    });
    await page.route(/\/_next\/image\?/, async (route) => {
      await page.waitForSelector('#images[data-hydrated="true"]');
      await route.fulfill({
        path: path.resolve("tests/fixtures/app-basic/public/lcp-image.jpg"),
        contentType: "image/jpeg",
      });
    });
    await page.goto(`/nextjs-compat/image-lcp/${mode}`);
    const lcp = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const image = (entry as PerformanceEntry & { element: HTMLImageElement | null })
                .element;
              if (image?.id === "hero") {
                observer.disconnect();
                resolve({
                  loading: image.getAttribute("loading"),
                  sameSrc:
                    image.src === (document.getElementById("duplicate") as HTMLImageElement).src,
                });
              }
            }
          });
          observer.observe({ type: "largest-contentful-paint", buffered: true });
        }),
    );
    expect(lcp).toEqual({
      loading: mode === "preload" ? null : mode === "lazy" ? "lazy" : "eager",
      sameSrc: true,
    });
    const warning = /was detected as the Largest Contentful Paint \(LCP\)/;
    if (mode === "lazy" && testInfo.project.name === "app-router") {
      await expect.poll(() => warnings.some((message) => warning.test(message))).toBe(true);
    } else {
      expect(warnings.some((message) => warning.test(message))).toBe(false);
    }
    void consoleErrors;
  });
}
