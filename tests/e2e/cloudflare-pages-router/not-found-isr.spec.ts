import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4177";

function renderedAt(html: string): string | undefined {
  return html.match(/<p id="rendered-at">(\d+)<\/p>/)?.[1];
}

// Next.js caches a getStaticProps /404 under "/404" and renders it for that
// pathname, so one visitor's missing URL never reaches another visitor's 404:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/pages/pages-handler.ts
test("keeps a missing request's path out of the shared /404 document", async ({ request }) => {
  const token = "CLOUDFLARE_SHARED_404_PATH_TOKEN";
  // Other specs share this /404 entry, so retry until the share request is
  // the one that finds it stale and regenerates it.
  let victimHtml = "";
  await expect
    .poll(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        const victim = await request.get(`${BASE}/share/${token}`);
        expect(victim.status()).toBe(404);
        victimHtml = await victim.text();
        return victim.headers()["x-vinext-cache"];
      },
      { intervals: [0], timeout: 15_000 },
    )
    .toBe("STALE");
  expect(victimHtml).not.toContain(token);

  let attackerHtml = "";
  await expect
    .poll(async () => {
      const attacker = await request.get(`${BASE}/missing/attacker`);
      attackerHtml = await attacker.text();
      return (
        attacker.status() === 404 &&
        attacker.headers()["x-vinext-cache"] === "HIT" &&
        renderedAt(attackerHtml) !== renderedAt(victimHtml)
      );
    })
    .toBe(true);
  expect(attackerHtml).not.toContain(token);
  expect(attackerHtml).toContain('<p id="as-path">/404</p>');
});
