import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import {
  createPagesFontFixture,
  startPagesFontDevelopment,
  startPagesFontProduction,
} from "../../pages-font-google-fixture.js";

// Ported from Next.js: test/e2e/next-font/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/next-font/index.test.ts
for (const [mode, startServer] of [
  ["development", startPagesFontDevelopment],
  ["production", startPagesFontProduction],
] as const) {
  test(`Google font fallback order in ${mode}`, async ({ page }) => {
    test.setTimeout(90_000);
    const root = await createPagesFontFixture();
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer(root);
      const response = await fetch(server.url);
      expect(response.ok).toBe(true);
      await page.setContent(await response.text(), { waitUntil: "domcontentloaded" });
      for (const [text, family] of [
        ["Adjusted and manual fallback", "Geist, Geist Fallback, system-ui, Arial"],
        ["No adjusted fallback", "Open Sans"],
        ["Manual fallback only", "Roboto, system-ui, Arial"],
      ]) {
        const fontFamily = await page
          .getByText(text, { exact: true })
          .evaluate((element) => getComputedStyle(element).fontFamily.replace(/['"]/g, ""));
        expect(fontFamily).toBe(family);
      }
    } finally {
      await page.close();
      await server?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
