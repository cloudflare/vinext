/**
 * E2E tests for @next/og ImageResponse (OG image generation).
 *
 * Tests that /api/og returns a valid PNG at the expected dimensions (1200×630),
 * that the title query param changes the output, and that different params
 * produce different images.
 *
 * This spec runs across three Playwright projects:
 *   - app-router      (app-basic fixture, Vite dev, port 4174)
 *   - cloudflare-dev  (app-router-cloudflare, Vite dev + @cloudflare/vite-plugin, port 4178)
 *   - cloudflare-workers (app-router-cloudflare, wrangler/miniflare, port 4176)
 *
 * PNG signature bytes: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
 * PNG width/height are encoded as big-endian uint32 at bytes 16-19 and 20-23
 * of the IHDR chunk (which starts at byte 8).
 */

import { test, expect } from "@playwright/test";

/** Read a big-endian uint32 from a Buffer at the given offset. */
function readUint32BE(buf: Buffer, offset: number): number {
  return (
    ((buf[offset] << 24) |
      (buf[offset + 1] << 16) |
      (buf[offset + 2] << 8) |
      buf[offset + 3]) >>>
    0
  );
}

test.describe("OG Image Generation (@next/og)", () => {
  test("GET /api/og returns a PNG", async ({ request }) => {
    const response = await request.get("/api/og");
    expect(response.status()).toBe(200);

    const contentType = response.headers()["content-type"];
    expect(contentType).toContain("image/png");
  });

  test("GET /api/og returns a PNG with correct dimensions (1200×630)", async ({
    request,
  }) => {
    const response = await request.get("/api/og");
    expect(response.status()).toBe(200);

    const buffer = Buffer.from(await response.body());

    // Verify PNG signature
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50); // P
    expect(buffer[2]).toBe(0x4e); // N
    expect(buffer[3]).toBe(0x47); // G

    // IHDR chunk starts at byte 8; width at byte 16, height at byte 20
    const width = readUint32BE(buffer, 16);
    const height = readUint32BE(buffer, 20);

    expect(width).toBe(1200);
    expect(height).toBe(630);
  });

  test("GET /api/og without title uses default text", async ({ request }) => {
    const response = await request.get("/api/og");
    expect(response.status()).toBe(200);

    // Must be a non-empty PNG
    const buffer = Buffer.from(await response.body());
    expect(buffer.length).toBeGreaterThan(1000);

    // PNG signature
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50);
  });

  test("GET /api/og?title=Hello renders with custom title", async ({
    request,
  }) => {
    const response = await request.get("/api/og?title=Hello");
    expect(response.status()).toBe(200);

    const contentType = response.headers()["content-type"];
    expect(contentType).toContain("image/png");

    const buffer = Buffer.from(await response.body());
    expect(buffer.length).toBeGreaterThan(1000);
  });

  test("different title params produce different images", async ({
    request,
  }) => {
    const [res1, res2] = await Promise.all([
      request.get("/api/og?title=Hello"),
      request.get("/api/og?title=World"),
    ]);

    expect(res1.status()).toBe(200);
    expect(res2.status()).toBe(200);

    const buf1 = Buffer.from(await res1.body());
    const buf2 = Buffer.from(await res2.body());

    // Both must be valid PNGs
    expect(buf1[0]).toBe(0x89);
    expect(buf2[0]).toBe(0x89);

    // Different text → different pixels → different buffers
    expect(buf1.equals(buf2)).toBe(false);
  });

  test("same title param produces identical images (deterministic)", async ({
    request,
  }) => {
    const [res1, res2] = await Promise.all([
      request.get("/api/og?title=Deterministic"),
      request.get("/api/og?title=Deterministic"),
    ]);

    expect(res1.status()).toBe(200);
    expect(res2.status()).toBe(200);

    const buf1 = Buffer.from(await res1.body());
    const buf2 = Buffer.from(await res2.body());

    expect(buf1.equals(buf2)).toBe(true);
  });
});
