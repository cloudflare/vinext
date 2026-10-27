/**
 * vinext runs next-intl's catalog loader on `experimental.messages` catalogs.
 * https://github.com/cloudflare/vinext/issues/4303
 */
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toSlash } from "pathslash";
import type { Plugin } from "vite";
import type { NextIntlCatalogLoader } from "../packages/vinext/src/config/next-config.js";
import { createNextIntlCatalogPlugin } from "../packages/vinext/src/plugins/next-intl-catalog.js";

// Resolves next-intl (and its codecs) from a real installed app.
const root = path.resolve(import.meta.dirname, "fixtures", "cf-next-intl-example");

type LoadHook = {
  filter: { id: RegExp };
  handler: (id: string) => Promise<{ code: string; moduleType: string } | null>;
};

function createLoadHook(catalogLoader: NextIntlCatalogLoader | null): LoadHook | null {
  const plugin = createNextIntlCatalogPlugin(
    () => toSlash(root),
    () => catalogLoader,
  );
  const applied = (plugin.applyToEnvironment as () => Plugin | false)();
  return applied ? (applied.load as unknown as LoadHook) : null;
}

async function load(hook: LoadHook, id: string) {
  if (!hook.filter.id.test(id)) return null;
  return hook.handler(id);
}

describe("next-intl catalog plugin", () => {
  let catalogDir: string;

  beforeEach(() => {
    catalogDir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "vinext-intl-catalog-")),
    );
    fs.writeFileSync(
      path.join(catalogDir, "en.json"),
      JSON.stringify({ About: { heading: "About {house}" } }),
    );
    fs.writeFileSync(
      path.join(catalogDir, "en.po"),
      'msgctxt "About"\nmsgid "heading"\nmsgstr "About {house}"\n',
    );
  });

  afterEach(() => {
    fs.rmSync(catalogDir, { recursive: true, force: true });
  });

  it("is not added without a catalog loader rule", () => {
    expect(createLoadHook(null)).toBeNull();
  });

  it("precompiles JSON catalogs", async () => {
    const hook = createLoadHook({
      include: [catalogDir],
      test: /\.json$/,
      options: { messages: { path: "./messages", format: "json", precompile: true } },
    })!;
    const id = toSlash(path.join(catalogDir, "en.json"));
    const result = await load(hook, id);
    expect(result?.moduleType).toBe("js");
    expect(result?.code).toBe(
      `export default JSON.parse(${JSON.stringify(JSON.stringify({ About: { heading: ["About ", ["house"]] } }))});`,
    );
    // Client dev requests carry `?import`; HMR adds `?t=`.
    expect((await load(hook, `${id}?import&t=1`))?.code).toBe(result?.code);
  });

  it("compiles catalogs without precompiling their messages", async () => {
    const hook = createLoadHook({
      include: [catalogDir],
      test: /\.json$/,
      options: { messages: { path: "./messages", format: "json" } },
    })!;
    const result = await load(hook, toSlash(path.join(catalogDir, "en.json")));
    expect(result?.code).toBe(
      `export default JSON.parse(${JSON.stringify(JSON.stringify({ About: { heading: "About {house}" } }))});`,
    );
  });

  // next-intl's loader caches its codec at module scope, so a config with
  // another format must not reuse the codec of one loaded before it.
  it("uses each config's own catalog format", async () => {
    const options = (format: string) => ({ messages: { path: "./messages", format } });
    const json = createLoadHook({
      include: [catalogDir],
      test: /\.json$/,
      options: options("json"),
    })!;
    const po = createLoadHook({ include: [catalogDir], test: /\.po$/, options: options("po") })!;
    const expected = `export default JSON.parse(${JSON.stringify(JSON.stringify({ About: { heading: "About {house}" } }))});`;
    expect((await load(json, toSlash(path.join(catalogDir, "en.json"))))?.code).toBe(expected);
    expect((await load(po, toSlash(path.join(catalogDir, "en.po"))))?.code).toBe(expected);
  });

  // With resolve.preserveSymlinks, Vite keeps the symlinked (logical) path in ids.
  it("loads catalogs through both the real and a symlinked directory path", async () => {
    const linkDir = path.join(path.dirname(catalogDir), `${path.basename(catalogDir)}-link`);
    fs.symlinkSync(catalogDir, linkDir, "junction");
    try {
      const hook = createLoadHook({
        include: [linkDir],
        test: /\.json$/,
        options: { messages: { path: "./messages", format: "json", precompile: true } },
      })!;
      const logical = await load(hook, toSlash(path.join(linkDir, "en.json")));
      const real = await load(hook, toSlash(path.join(catalogDir, "en.json")));
      expect(logical?.code).toContain('[\\"About \\",[\\"house\\"]]');
      expect(real?.code).toBe(logical?.code);
    } finally {
      fs.rmSync(linkDir, { force: true });
    }
  });

  it("leaves other files and explicit raw/url imports to Vite", async () => {
    const hook = createLoadHook({
      include: [catalogDir],
      test: /\.json$/,
      options: { messages: { path: "./messages", format: "json", precompile: true } },
    })!;
    const id = toSlash(path.join(catalogDir, "en.json"));
    expect(await load(hook, `${id}?raw`)).toBeNull();
    expect(await load(hook, `${id}?url`)).toBeNull();
    expect(await load(hook, toSlash(path.join(catalogDir, "en.po")))).toBeNull();
    expect(await load(hook, toSlash(path.join(root, "messages", "en.json")))).toBeNull();
  });
});
