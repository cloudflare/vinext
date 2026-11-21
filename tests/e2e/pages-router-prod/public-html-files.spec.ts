import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4175";

// Like `next start`, a public .html file is served only at its own pathname:
// public/html-alias.html is not served at /html-alias, and
// public/html-alias-dir/index.html is not served at /html-alias-dir.
test.describe("public .html files", () => {
  test("are served at their own pathnames", async ({ request }) => {
    const file = await request.get(`${BASE}/html-alias.html`);
    expect(file.status()).toBe(200);
    expect(await file.text()).toContain("html-alias-file");

    const index = await request.get(`${BASE}/html-alias-dir/index.html`);
    expect(index.status()).toBe(200);
    expect(await index.text()).toContain("html-alias-dir-index");
  });

  test("are not served without their .html or /index.html suffix", async ({ request }) => {
    for (const pathname of ["/html-alias", "/html-alias-dir"]) {
      const response = await request.get(`${BASE}${pathname}`);
      expect(response.status(), pathname).toBe(404);
      const body = await response.text();
      expect(body, pathname).not.toContain("html-alias-file");
      expect(body, pathname).not.toContain("html-alias-dir-index");
    }
  });
});
