import { expect, test } from "@playwright/test";

function renderedAt(html: string): string {
  const match = html.match(/<p id="isr-style-rendered-at">(\d+)<\/p>/);
  if (!match) throw new Error("Missing render timestamp");
  return match[1];
}

test("keeps markup-looking style text inert across stale regeneration on Workers", async ({
  page,
  request,
}) => {
  // Valid CSS string text that spells out the end of `#__next` and a
  // `__NEXT_DATA__` script. A text scan of the cached shell would lift the
  // `<img>` between them out of the style when it splices in the fresh body.
  const slug =
    `s${Date.now().toString(36)}</div><img src=x onerror=window.__isrStyleXss=1>` +
    "<script id='__NEXT_DATA__' type='application/json'>";
  const path = `/isr-style/${encodeURIComponent(slug)}`;

  const miss = await request.get(path);
  expect(miss.status()).toBe(200);
  expect(miss.headers()["x-vinext-cache"]).toBe("MISS");
  const missHtml = await miss.text();
  expect(missHtml).toContain("<img src=x onerror=window.__isrStyleXss=1>");
  const firstRender = renderedAt(missHtml);

  // Poll rather than sleep a fixed interval: the MISS entry is written in the
  // background, so its one-second window may start after the response.
  await expect
    .poll(async () => (await request.get(path)).headers()["x-vinext-cache"], {
      intervals: [1_100, 250],
      timeout: 10_000,
    })
    .toBe("STALE");

  // The STALE response scheduled the regeneration in the background; wait for
  // a response served from the regenerated entry.
  let regeneratedHtml = "";
  await expect
    .poll(
      async () => {
        const response = await request.get(path);
        regeneratedHtml = await response.text();
        return renderedAt(regeneratedHtml) !== firstRender;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  // Only the inert copy inside the style text remains.
  expect(regeneratedHtml.match(/<img/g)).toHaveLength(1);

  await page.goto(path);
  await page.waitForLoadState("load");
  expect(renderedAt(await page.content())).not.toBe(firstRender);
  expect(await page.evaluate(() => document.images.length)).toBe(0);
  expect(await page.evaluate(() => "__isrStyleXss" in window)).toBe(false);
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--isr-style-slug"),
    ),
  ).toContain("onerror=window.__isrStyleXss=1");
});
