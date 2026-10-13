import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { describe, expect, it, vi } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-basic");

function adjustedFallbackCSS(code: string): string | undefined {
  const match = /adjustedFallbackCSS: ("(?:[^"\\]|\\.)*")/.exec(code);
  return match ? JSON.parse(match[1]) : undefined;
}

function sizeAdjust(css: string | undefined): string | undefined {
  return css && /size-adjust: ([\d.]+%)/.exec(css)?.[1];
}

describe("next/font/local adjustFontFallback in dev", () => {
  it("regenerates the fallback face in every environment when the font changes", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-font-local-dev-")));
    const fontFile = path.join(root, "app", "font.woff2");
    fs.mkdirSync(path.dirname(fontFile));
    fs.symlinkSync(
      path.join(process.cwd(), "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    fs.copyFileSync(path.join(FIXTURE_DIR, "app/script-nonce/with-next-font/font.woff2"), fontFile);
    fs.writeFileSync(
      path.join(root, "app", "font.ts"),
      `import localFont from "next/font/local";\n` +
        `export const roboto = localFont({ src: "./font.woff2" });\n`,
    );
    fs.writeFileSync(
      path.join(root, "app", "layout.tsx"),
      `export default function RootLayout({ children }) { return <html><body>{children}</body></html>; }\n`,
    );
    fs.writeFileSync(path.join(root, "app", "page.tsx"), `export default () => null;\n`);

    const server = await createServer({
      root,
      configFile: false,
      cacheDir: path.join(root, ".vite"),
      logLevel: "silent",
      plugins: [vinext({ appDir: root })],
      server: { port: 0 },
    });
    const environments = Object.values(server.environments);
    const sizeAdjustByEnvironment = async () =>
      Object.fromEntries(
        await Promise.all(
          environments.map(async (environment) => {
            const result = await environment.transformRequest("/app/font.ts");
            return [environment.name, sizeAdjust(adjustedFallbackCSS(result!.code))];
          }),
        ),
      );

    try {
      expect(environments.map((environment) => environment.name)).toEqual(
        expect.arrayContaining(["client", "ssr", "rsc"]),
      );
      // Roboto and Noto Sans against Arial, as in font-local-transform.test.ts.
      const expectAll = (value: string) =>
        Object.fromEntries(environments.map((environment) => [environment.name, value]));
      expect(await sizeAdjustByEnvironment()).toEqual(expectAll("100.30%"));

      fs.copyFileSync(path.join(FIXTURE_DIR, "assets/noto-sans.ttf"), fontFile);

      // The rsc and ssr environments only soft-invalidate a module that
      // statically imports the changed font; it must still re-run the
      // transform there rather than keep the old metrics.
      await vi.waitFor(
        async () => expect(await sizeAdjustByEnvironment()).toEqual(expectAll("106.47%")),
        { timeout: 10_000, interval: 100 },
      );
    } finally {
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
