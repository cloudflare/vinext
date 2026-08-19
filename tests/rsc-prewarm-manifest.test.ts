import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emitRscPrewarmManifest,
  getRscPrewarmManifestUrl,
  writeRscPrewarmManifest,
} from "../packages/vinext/src/build/rsc-prewarm-manifest.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-rsc-prewarm-manifest-"));
  fs.mkdirSync(path.join(root, "dist/server"), { recursive: true });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("RSC prewarm build manifest", () => {
  it("emits build-scoped deployment paths from final ISR results", () => {
    fs.writeFileSync(
      path.join(root, "dist/server/vinext-prerender.json"),
      JSON.stringify({
        routes: [
          {
            route: "/",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
          },
          {
            route: "/cached/:slug",
            path: "/cached/intro",
            status: "rendered",
            router: "app",
            revalidate: 60,
            fallback: false,
          },
          {
            route: "/dynamic",
            status: "skipped",
            router: "app",
          },
        ],
      }),
    );
    const config = {
      assetPrefix: "",
      basePath: "/docs",
      buildId: "build-a",
      deploymentId: "deployment-a",
      trailingSlash: true,
    };

    emitRscPrewarmManifest(root, config);

    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(root, "dist/client/_next/static/build-a/vinext-rsc-prewarm.json"),
          "utf-8",
        ),
      ),
    ).toEqual({ version: 1, paths: ["/docs/", "/docs/cached/intro/"] });
    expect(getRscPrewarmManifestUrl(config)).toBe(
      "/_next/static/build-a/vinext-rsc-prewarm.json?dpl=deployment-a",
    );
  });

  it("writes an empty fail-closed manifest for builds without a prerender pass", () => {
    const config = {
      assetPrefix: "",
      basePath: "",
      buildId: "build-a",
      deploymentId: undefined,
      trailingSlash: false,
    };
    const clientDir = path.join(root, "custom-client");

    writeRscPrewarmManifest(clientDir, config, []);

    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(clientDir, "_next/static/build-a/vinext-rsc-prewarm.json"),
          "utf-8",
        ),
      ),
    ).toEqual({ version: 1, paths: [] });
  });
});
