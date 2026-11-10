import fs from "node:fs/promises";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4175";
const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/pages-basic");
const CLIENT_DIR = path.join(FIXTURE_DIR, "dist/client");

// Text that only the Pages data exports on /sourcemap-data/* use.
const DATA_EXPORT_TEXT = [
  "SOURCEMAP_IMPORTED_SERVER_MODULE",
  "SOURCEMAP_SERVER_HELPER",
  "SOURCEMAP_SERVER_PROPS",
  "SOURCEMAP_STATIC_PATHS",
  "SOURCEMAP_STATIC_PROPS",
  "SOURCEMAP_MDX_SERVER_PROPS",
  "SOURCEMAP_LOADED_SERVER_PROPS",
];

// pages-basic builds with client sourcemaps; the data exports the client build
// strips are left out of them too.
test("keeps Pages data exports out of emitted client sourcemaps", async () => {
  const files = (await fs.readdir(CLIENT_DIR, { recursive: true })).filter(
    (file) => file.endsWith(".js") || file.endsWith(".js.map"),
  );
  const leaks: string[] = [];
  const sources = new Map<string, (string | null)[]>();
  for (const file of files) {
    const content = await fs.readFile(path.join(CLIENT_DIR, file), "utf8");
    for (const text of DATA_EXPORT_TEXT) {
      if (content.includes(text)) leaks.push(`${file}: ${text}`);
    }
    if (!file.endsWith(".map")) continue;
    const map = JSON.parse(content) as { sources: string[]; sourcesContent?: (string | null)[] };
    map.sources.forEach((source, index) => {
      const contents = sources.get(source) ?? [];
      contents.push(map.sourcesContent?.[index] ?? null);
      sources.set(source, contents);
    });
  }
  const contentOf = (suffix: string) =>
    [...sources].filter(([source]) => source.endsWith(suffix)).flatMap(([, content]) => content);

  expect(leaks).toEqual([]);
  // The page components stay debuggable at their original lines.
  const serverPropsPage = await fs.readFile(
    path.join(FIXTURE_DIR, "pages/sourcemap-data/server-props.tsx"),
    "utf8",
  );
  const [serverPropsContent] = contentOf("sourcemap-data/server-props.tsx");
  expect(serverPropsContent?.split("\n").length).toBe(serverPropsPage.split("\n").length);
  expect(serverPropsContent).toContain(
    '    <button id="sourcemap-data-button" onClick={() => setClicks(clicks + 1)}>',
  );
  expect(contentOf("sourcemap-data/[slug].jsx")).toEqual([
    expect.stringContaining("SOURCEMAP_STATIC_COMPONENT"),
  ]);
});

test("keeps Pages data exports out of served sourcemaps", async ({ page, request }) => {
  const scriptUrls = new Set<string>();
  page.on("response", (response) => {
    if (response.request().resourceType() === "script") scriptUrls.add(response.url());
  });
  await page.goto(`${BASE}/sourcemap-data/server-props`);
  await waitForHydration(page);
  await page.locator("#sourcemap-data-button").click();
  await expect(page.locator("#sourcemap-data-button")).toHaveText(
    /SOURCEMAP_CLIENT_COMPONENT SOURCEMAP_SERVER_PROPS \d+ 1/,
  );
  await page.goto(`${BASE}/sourcemap-data/sourcemap_static_paths`);
  await expect(page.locator("#sourcemap-data-static")).toHaveText(
    "SOURCEMAP_STATIC_COMPONENT SOURCEMAP_STATIC_PROPS 22",
  );
  await page.goto(`${BASE}/sourcemap-data/loaded`);
  await expect(page.locator("#sourcemap-data-loaded")).toHaveText("SOURCEMAP_LOADED_COMPONENT 29");
  await page.goto(`${BASE}/sourcemap-data/mdx`);
  await expect(page.locator("h1")).toHaveText("SOURCEMAP_MDX_CONTENT 26");

  // Follow each served script's sourceMappingURL, as any visitor can.
  let mapCount = 0;
  for (const scriptUrl of scriptUrls) {
    const script = await (await request.get(scriptUrl)).text();
    const mapUrl = script.match(/\/\/# sourceMappingURL=(\S+)\s*$/)?.[1];
    if (!mapUrl) continue;
    const response = await request.get(new URL(mapUrl, scriptUrl).href);
    expect(response.status()).toBe(200);
    const map = await response.text();
    mapCount++;
    for (const text of DATA_EXPORT_TEXT) expect(map, `${mapUrl}: ${text}`).not.toContain(text);
  }
  expect(mapCount).toBeGreaterThan(0);
});
