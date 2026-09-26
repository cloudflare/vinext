import { describe, expect, it } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createWorkersCacheConfig,
  createWorkersResponseStoreSelfContainedConfig,
  createWorkersResponseStoreServiceBindingConfig,
} from "../packages/cloudflare/src/cache/config.js";

describe("typed Cloudflare cache config", () => {
  it("keeps web previews on the existing main-managed Response Store Worker", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from "node:assert/strict";
         import { readFileSync } from "node:fs";
         import config, { responseStoreServiceBinding } from "./apps/web/cloudflare.config.ts";
         assert.equal(responseStoreServiceBinding.name, "vinext-web-response-store");
         assert.equal(config.worker.env.RESPONSE_STORE.worker.name, "vinext-web-response-store");
         const workflow = readFileSync(".github/workflows/deploy-examples.yml", "utf8");
         const step = workflow.split("- name: Deploy configured Response Store service with cf")[1].split("\\n      - name:")[0];
         assert.ok(step.includes("if: github.event_name == 'push' && github.ref == 'refs/heads/main' &&"));
         assert.ok(!step.includes("github.event.pull_request"));
         assert.ok(!workflow.includes("VINEXT_RESPONSE_STORE_WORKER_NAME"));
         assert.ok(!workflow.includes("Delete web Response Store preview Worker"));`,
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        env: { ...process.env, VINEXT_RESPONSE_STORE_WORKER_NAME: "pr-unexpected-response-store" },
      },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("leaves the optional plugin peer open to minor-version prereleases", () => {
    const pkg = JSON.parse(
      readFileSync(
        path.resolve(import.meta.dirname, "../packages/cloudflare/package.json"),
        "utf8",
      ),
    );
    expect(pkg.peerDependencies["@cloudflare/vite-plugin"]).toBe("*");
    expect(pkg.peerDependenciesMeta["@cloudflare/vite-plugin"].optional).toBe(true);
  });

  it.each([undefined, "2.0.0-beta.1", "2.1.0-beta.1", "2.5.3-beta.sha-example"])(
    "loads the consumer's optional plugin peer (%s) only when called",
    (version) => {
      const root = mkdtempSync(path.join(tmpdir(), "vinext-config-peer-"));
      try {
        const helper = path.join(root, "node_modules/@vinext/cloudflare");
        mkdirSync(helper, { recursive: true });
        writeFileSync(
          path.join(helper, "package.json"),
          JSON.stringify({ type: "module", exports: { "./cache/config": "./config.mjs" } }),
        );
        copyFileSync(
          path.resolve(import.meta.dirname, "../packages/cloudflare/src/cache/config.ts"),
          path.join(root, "config.ts"),
        );
        if (version) {
          const plugin = path.join(root, "node_modules/@cloudflare/vite-plugin");
          mkdirSync(plugin, { recursive: true });
          writeFileSync(
            path.join(plugin, "package.json"),
            JSON.stringify({
              type: "module",
              version,
              exports: { "./experimental-config": { import: "./config.js" } },
            }),
          );
          writeFileSync(
            path.join(plugin, "config.js"),
            `export const bindings = { versionMetadata: () => ({ version: ${JSON.stringify(version)} }) };
             export const exports = { worker: () => ({ version: ${JSON.stringify(version)} }) };`,
          );
        }
        const result = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import assert from "node:assert/strict";
             import { readFileSync, writeFileSync } from "node:fs";
             import { stripTypeScriptTypes } from "node:module";
             writeFileSync("./node_modules/@vinext/cloudflare/config.mjs", stripTypeScriptTypes(readFileSync("./config.ts", "utf8")));
             const { createWorkersCacheConfig } = await import("@vinext/cloudflare/cache/config");
             ${
               version
                 ? `const config = await createWorkersCacheConfig();
                  assert.equal(config.env.CF_VERSION_METADATA.version, ${JSON.stringify(version)});
                  assert.equal(config.exports.VinextCachedResponse.version, ${JSON.stringify(version)});`
                 : `await assert.rejects(createWorkersCacheConfig(), { code: "ERR_MODULE_NOT_FOUND" });`
             }`,
          ],
          { cwd: root, encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("creates Workers Cache bindings and exports", async () => {
    expect(await createWorkersCacheConfig()).toEqual({
      cache: { enabled: false },
      env: {
        CF_VERSION_METADATA: { type: "version-metadata" },
      },
      exports: {
        VinextCachedResponse: { type: "worker", cache: { enabled: true } },
        VinextUncachedResponse: { type: "worker", cache: { enabled: false } },
      },
    });
  });

  it("supports a custom Workers Cache version metadata binding", async () => {
    expect(
      (await createWorkersCacheConfig({ versionMetadataBinding: "CUSTOM_VERSION" })).env,
    ).toEqual({ CUSTOM_VERSION: { type: "version-metadata" } });
    await expect(createWorkersCacheConfig({ versionMetadataBinding: "" })).rejects.toThrow(
      "versionMetadataBinding must be a non-empty string",
    );
  });

  it("creates self-contained Workers Response Store config", async () => {
    expect(
      await createWorkersResponseStoreSelfContainedConfig({
        worker: "example",
        bucket: "example-cache-bodies",
      }),
    ).toEqual({
      cache: { enabled: true },
      exports: {
        CacheMetadata: { type: "durable-object", storage: "sqlite" },
        ResponseStoreBinding: { type: "worker", cache: { enabled: true } },
      },
      env: {
        CACHE_BODIES: { type: "r2", name: "example-cache-bodies" },
        CACHE_METADATA: {
          type: "durable-object",
          worker: "example",
          exportName: "CacheMetadata",
        },
        CF_VERSION_METADATA: { type: "version-metadata" },
      },
    });
  });

  it("creates service-binding Workers Response Store config", async () => {
    const config = await createWorkersResponseStoreServiceBindingConfig({
      worker: {
        name: "example-response-store",
        compatibilityDate: "2026-09-14",
        compatibilityFlags: ["nodejs_compat"],
        observability: { enabled: true },
      },
      bucket: "example-cache-bodies",
    });

    expect(config).toEqual({
      serviceBindingWorker: {
        name: "example-response-store",
        entrypoint: "@cloudflare/workers-response-store/service",
        compatibilityDate: "2026-09-14",
        compatibilityFlags: ["nodejs_compat"],
        observability: { enabled: true },
        workersDev: false,
        previewUrls: false,
        cache: { enabled: true },
        exports: {
          CacheMetadata: { type: "durable-object", storage: "sqlite" },
          ResponseStoreBinding: { type: "worker", cache: { enabled: true } },
        },
        env: {
          CACHE_BODIES: { type: "r2", name: "example-cache-bodies" },
          CACHE_METADATA: {
            type: "durable-object",
            worker: "example-response-store",
            exportName: "CacheMetadata",
          },
        },
      },
      applicationWorker: {
        cache: { enabled: false },
        env: {
          RESPONSE_STORE: {
            type: "worker",
            worker: config.serviceBindingWorker,
            exportName: "ResponseStoreService",
          },
          CF_VERSION_METADATA: { type: "version-metadata" },
        },
      },
    });
  });
});
