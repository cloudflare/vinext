import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { startFixtureServer } from "./helpers.js";

describe.each(["dev", "worker production"])(
  "next-intl precompile without webpack loaders: %s",
  (mode) => {
    let root: string;
    let server: ViteDevServer;
    let baseUrl: string;
    let worker: { dispose(): Promise<void>; url: Promise<URL> } | undefined;
    beforeAll(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-intl-precompile-"));
      fs.symlinkSync(
        path.resolve(import.meta.dirname, "fixtures/cf-next-intl/node_modules"),
        path.join(root, "node_modules"),
        "junction",
      );
      const files: Record<string, string> = {
        "package.json": '{"type":"module"}',
        "next.config.mjs":
          'import createNextIntlPlugin from "next-intl/plugin"; export default createNextIntlPlugin({ experimental: { messages: { path: "./messages", locales: "infer", sourceLocale: "en", format: "json", precompile: true } } })({});',
        "i18n/request.ts":
          'import { getRequestConfig } from "next-intl/server"; import messages from "../messages/en.json"; export default getRequestConfig(async () => ({locale:"en", messages}));',
        "messages/en.json": JSON.stringify({
          heading: "About {house}",
          count: "{count, plural, one {# room} other {# rooms}}",
        }),
        "app/layout.tsx":
          "export default function Layout({children}) { return <html><body>{children}</body></html> }",
        "app/client.tsx":
          '"use client"; import {useTranslations} from "next-intl"; export default function Client() { const t = useTranslations(); return <p id="client-heading">{t("heading",{house:"Client House"})}</p> }',
        "app/page.tsx":
          'import Client from "./client"; import {NextIntlClientProvider} from "next-intl"; import {getTranslations,getMessages} from "next-intl/server"; export const dynamic = "force-dynamic"; export default async function Page() { const t = await getTranslations(); const messages = await getMessages(); return <main><p>{t("heading",{house:"Orange House"})}</p><p>{t("count",{count:2})}</p><NextIntlClientProvider locale="en" messages={messages}><Client/></NextIntlClientProvider></main> }',
      };
      for (const [file, source] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), source);
      }
      if (mode === "dev") {
        ({ server, baseUrl } = await startFixtureServer(root));
      } else {
        fs.mkdirSync(path.join(root, "worker"), { recursive: true });
        fs.writeFileSync(
          path.join(root, "worker/index.ts"),
          'export {default} from "vinext/server/fetch-handler";',
        );
        fs.writeFileSync(
          path.join(root, "wrangler.jsonc"),
          JSON.stringify({
            name: "intl-precompile",
            compatibility_date: "2026-02-12",
            compatibility_flags: ["nodejs_compat"],
            main: "worker/index.ts",
            assets: { not_found_handling: "none", binding: "ASSETS" },
          }),
        );
        const { cloudflare } = await import(
          pathToFileURL(path.join(root, "node_modules/@cloudflare/vite-plugin/dist/index.mjs")).href
        );
        const builder = await createBuilder({
          root,
          configFile: false,
          plugins: [
            vinext({ appDir: root }),
            cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
          ],
          logLevel: "silent",
        });
        await builder.buildApp();
        const wrangler = await import(
          pathToFileURL(path.join(root, "node_modules/wrangler/wrangler-dist/cli.js")).href
        );
        worker = await wrangler.unstable_startWorker({
          config: path.join(root, "dist/server/wrangler.json"),
          dev: {
            remote: false,
            persist: false,
            logLevel: "none",
            watch: false,
            server: { port: 0 },
            inspector: { port: 0 },
          },
        });
        baseUrl = (await worker!.url).origin;
      }
    }, 180000);
    afterAll(async () => {
      await server?.close();
      await worker?.dispose();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    });
    it("interpolates raw catalogs instead of rendering placeholders literally", async () => {
      const response = await fetch(baseUrl);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("About Orange House");
      expect(html).toContain("2 rooms");
      expect(html).toContain("About Client House");
    });
  },
);
