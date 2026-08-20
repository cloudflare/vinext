import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  buildWranglerDeploymentsStatusArgs,
  buildWranglerTriggersDeployArgs,
  buildWranglerVersionDeployArgs,
  buildWranglerVersionUploadArgs,
  parseVersionId,
  parseWorkersDevUrl,
  parseWranglerDeploymentStatusOutput,
  parseWranglerVersionUploadOutput,
  runWranglerVersionDeploy,
  runWranglerVersionUpload,
} from "../packages/cloudflare/src/version-deploy.js";

describe("Cloudflare Wrangler version deployment helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds version upload args for production", () => {
    expect(buildWranglerVersionUploadArgs({})).toEqual({
      args: ["versions", "upload"],
      env: undefined,
    });
  });

  it("builds version upload args for a named environment and preview alias", () => {
    expect(buildWranglerVersionUploadArgs({ env: "staging", previewAlias: "warm-build" })).toEqual({
      args: ["versions", "upload", "--env", "staging", "--preview-alias", "warm-build"],
      env: "staging",
    });
  });

  it("builds version upload args for an explicit Worker name", () => {
    expect(
      buildWranglerVersionUploadArgs({
        name: "custom-worker",
        env: "staging",
        previewAlias: "warm-build",
      }),
    ).toEqual({
      args: [
        "versions",
        "upload",
        "--name",
        "custom-worker",
        "--env",
        "staging",
        "--preview-alias",
        "warm-build",
      ],
      env: "staging",
    });
  });

  it("builds version upload args for an explicit Wrangler config", () => {
    expect(buildWranglerVersionUploadArgs({ config: "dist/server/wrangler.json" })).toEqual({
      args: ["versions", "upload", "--config", "dist/server/wrangler.json"],
      env: undefined,
    });
  });

  it("builds non-interactive version deploy args for the uploaded version", () => {
    expect(
      buildWranglerVersionDeployArgs(
        [{ versionId: "095f00a7-23a7-43b7-a227-e4c97cab5f22", percentage: 100 }],
        {},
      ),
    ).toEqual({
      args: ["versions", "deploy", "095f00a7-23a7-43b7-a227-e4c97cab5f22@100%", "--yes"],
      env: undefined,
    });
  });

  it("builds non-interactive split deployment args for staging a version", () => {
    expect(
      buildWranglerVersionDeployArgs(
        [
          { versionId: "11111111-1111-4111-8111-111111111111", percentage: 100 },
          { versionId: "22222222-2222-4222-8222-222222222222", percentage: 0 },
        ],
        { env: "staging" },
      ),
    ).toEqual({
      args: [
        "versions",
        "deploy",
        "11111111-1111-4111-8111-111111111111@100%",
        "22222222-2222-4222-8222-222222222222@0%",
        "--yes",
        "--env",
        "staging",
      ],
      env: "staging",
    });
  });

  it("logs distinct labels for staged and promoted version deploys", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const execute = vi.fn(() => "Deployed version\nhttps://app.example.workers.dev\n");

    runWranglerVersionDeploy(
      "/tmp/app",
      [
        { versionId: "11111111-1111-4111-8111-111111111111", percentage: 100 },
        { versionId: "22222222-2222-4222-8222-222222222222", percentage: 0 },
      ],
      {},
      "stage",
      execute as never,
    );
    runWranglerVersionDeploy(
      "/tmp/app",
      [{ versionId: "22222222-2222-4222-8222-222222222222", percentage: 100 }],
      {},
      "promote-warmed",
      execute as never,
    );
    runWranglerVersionDeploy(
      "/tmp/app",
      [{ versionId: "22222222-2222-4222-8222-222222222222", percentage: 100 }],
      { env: "staging" },
      "promote-uploaded",
      execute as never,
    );

    expect(log).toHaveBeenCalledWith(
      "\n  Staging uploaded Worker version at 0% for CDN warmup in production...",
    );
    expect(log).toHaveBeenCalledWith("\n  Promoting warmed Worker version to production...");
    expect(log).toHaveBeenCalledWith("\n  Promoting uploaded Worker version to env: staging...");
  });

  it("asks for an initial deploy without CDN pre-warm when the Worker does not exist yet", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const execute = vi.fn(() => {
      throw Object.assign(new Error("Command failed"), {
        stderr:
          "✘ [ERROR] You cannot upload a new version of a Worker that does not yet exist. Please run the `deploy` command first.",
      });
    });

    expect(() => runWranglerVersionUpload("/tmp/app", {}, execute as never)).toThrow(
      "Run `vinext-cloudflare deploy` once without `--experimental-warm-cdn-cache` to create the Worker",
    );
  });

  it("builds deployment status args for environments", () => {
    expect(buildWranglerDeploymentsStatusArgs({ env: "preview" })).toEqual({
      args: ["deployments", "status", "--json", "--env", "preview"],
      env: "preview",
    });
  });

  it("builds deployment status args for an explicit Worker name", () => {
    expect(buildWranglerDeploymentsStatusArgs({ name: "custom-worker" })).toEqual({
      args: ["deployments", "status", "--json", "--name", "custom-worker"],
      env: undefined,
    });
  });

  it("builds deployment status args for an explicit Wrangler config", () => {
    expect(buildWranglerDeploymentsStatusArgs({ config: "dist/server/wrangler.json" })).toEqual({
      args: ["deployments", "status", "--json", "--config", "dist/server/wrangler.json"],
      env: undefined,
    });
  });

  it("builds trigger deployment args for environments", () => {
    expect(buildWranglerTriggersDeployArgs({ env: "preview" })).toEqual({
      args: ["triggers", "deploy", "--env", "preview"],
      env: "preview",
    });
  });

  it("parses version IDs and preview URLs from Wrangler text output", () => {
    const output = `
      Uploaded app 095f00a7-23a7-43b7-a227-e4c97cab5f22
      https://app-warm.example.workers.dev
    `;

    expect(parseVersionId(output)).toBe("095f00a7-23a7-43b7-a227-e4c97cab5f22");
    expect(parseWorkersDevUrl(output)).toBe("https://app-warm.example.workers.dev");
    expect(parseWranglerVersionUploadOutput(output)).toMatchObject({
      versionId: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
      previewUrl: "https://app-warm.example.workers.dev",
    });
  });

  it("parses workers.dev URLs without depending on a broad URL regex", () => {
    expect(parseWorkersDevUrl("Preview: <https://app.example.workers.dev/path?x=1>.")).toBe(
      "https://app.example.workers.dev/path?x=1",
    );
    expect(parseWorkersDevUrl(`https://${"a".repeat(2048)}.example.com`)).toBeNull();
  });

  it("parses version upload JSON output", () => {
    expect(
      parseWranglerVersionUploadOutput(
        JSON.stringify({
          version: { id: "095f00a7-23a7-43b7-a227-e4c97cab5f22" },
          preview_url: "https://app-warm.example.workers.dev",
        }),
      ),
    ).toMatchObject({
      versionId: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
      previewUrl: "https://app-warm.example.workers.dev",
    });
  });

  it("does not treat unrelated nested JSON IDs and URLs as upload metadata", () => {
    expect(
      parseWranglerVersionUploadOutput(
        JSON.stringify({
          version_id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
          preview_url: "https://app-warm.example.workers.dev",
          diagnostics: {
            id: "not-the-version",
            url: "https://not-preview.example.workers.dev",
          },
        }),
      ),
    ).toMatchObject({
      versionId: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
      previewUrl: "https://app-warm.example.workers.dev",
    });
  });

  it("throws when upload output lacks a version ID", () => {
    expect(() => parseWranglerVersionUploadOutput("uploaded")).toThrow(
      "Could not detect Worker version ID",
    );
  });

  it("keeps the uploaded version when Wrangler does not return a preview URL", () => {
    expect(parseWranglerVersionUploadOutput("095f00a7-23a7-43b7-a227-e4c97cab5f22")).toMatchObject({
      versionId: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
      previewUrl: null,
    });
  });

  it("parses current deployment version traffic", () => {
    expect(
      parseWranglerDeploymentStatusOutput(
        JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        }),
      ).versions,
    ).toEqual([{ versionId: "11111111-1111-4111-8111-111111111111", percentage: 100 }]);
  });
});
