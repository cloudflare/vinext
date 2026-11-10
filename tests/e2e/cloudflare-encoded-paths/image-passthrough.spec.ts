import { expect, test } from "@playwright/test";

// This App Router Worker configures no image optimizer. Like the Pages Router
// Worker and the Node server, it serves an admitted source unoptimized with
// Next.js's image headers instead of redirecting to the source.
test.describe("/_next/image without an image optimizer", () => {
  test("serves the source as-is instead of redirecting to it", async ({ request }) => {
    const original = Buffer.from(await (await request.get("/vinext-image.png")).body());
    const response = await request.get("/_next/image?url=%2Fvinext-image.png&w=64&q=75", {
      headers: { Accept: "image/avif,image/webp,*/*" },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["location"]).toBeUndefined();
    expect(response.headers()["content-type"]).toBe("image/png");
    expect(Buffer.from(await response.body()).equals(original)).toBe(true);
    // Next.js's image policy at the default `images.minimumCacheTTL`.
    expect(response.headers()["cache-control"]).toBe("public, max-age=14400, must-revalidate");
    expect(response.headers()["content-security-policy"]).toBe(
      "script-src 'none'; frame-src 'none'; sandbox;",
    );
    expect(response.headers()["x-nextjs-cache"]).toBe("MISS");
  });

  test("rejects a missing source", async ({ request }) => {
    const response = await request.get("/_next/image?url=%2Fmissing.png&w=64&q=75", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(400);
    expect(await response.text()).toBe("The requested resource isn't a valid image.");
  });
});
