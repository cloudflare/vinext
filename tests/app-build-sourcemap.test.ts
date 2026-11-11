import fs from "node:fs";
import path from "node:path";
import { createBuilder, createLogger } from "vite";
import { afterAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const FIXTURE_SOURCE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-flight-framing");

describe("App Router production build with build.sourcemap", () => {
  let fixtureDir = "";

  afterAll(() => {
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  // https://github.com/cloudflare/vinext/issues/4667
  it("emits no SOURCEMAP_BROKEN warnings from vinext plugins", async () => {
    fixtureDir = await createIsolatedFixture(FIXTURE_SOURCE_DIR, "vinext-build-sourcemap-");
    fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');

    const warnings: string[] = [];
    const logger = createLogger("warn");
    const warn = logger.warn.bind(logger);
    logger.warn = (msg, options) => {
      warnings.push(msg);
      warn(msg, options);
    };

    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      build: { sourcemap: true },
      customLogger: logger,
    });
    await builder.buildApp();

    // rsc:* SOURCEMAP_BROKEN warnings come from @vitejs/plugin-rsc; only
    // vinext's own plugins are asserted here.
    const vinextSourcemapBroken = warnings.filter(
      (w) => w.includes("SOURCEMAP_BROKEN") && w.includes("vinext:"),
    );
    expect(vinextSourcemapBroken).toEqual([]);

    // The action owner manifest import is still pointed at the file written
    // beside the RSC entry.
    const rscEntry = fs.readFileSync(path.join(fixtureDir, "dist/server/index.js"), "utf8");
    expect(rscEntry).toContain('"./__vinext_action_owner_manifest.js"');
    expect(rscEntry).not.toContain("virtual:vinext-action-owner-manifest");
    expect(
      fs.existsSync(path.join(fixtureDir, "dist/server/__vinext_action_owner_manifest.js")),
    ).toBe(true);
  }, 180_000);
});
