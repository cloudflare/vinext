import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4179";

test.describe("Pages Router on Cloudflare Workers (vite dev)", () => {
  test("home page is server-rendered inside the Cloudflare Worker", async ({ request }) => {
    const res = await request.get(`${BASE}/`);
    expect(res.status()).toBe(200);

    const html = await res.text();
    expect(html).toContain("Hello from Pages Router on Workers!");
    expect(html).toContain("__NEXT_DATA__");
  });

  test("GSSP runs inside the Cloudflare Worker", async ({ request }) => {
    // getServerSideProps on /ssr reads navigator.userAgent and embeds it in
    // the rendered HTML. "Cloudflare-Workers" can only appear if GSSP executed
    // inside miniflare — it is absent from the Node.js host environment.
    const res = await request.get(`${BASE}/ssr`);
    expect(res.status()).toBe(200);

    const html = await res.text();
    expect(html).toContain("Cloudflare-Workers");
  });
});
