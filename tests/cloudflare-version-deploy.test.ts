import { describe, expect, it } from "vite-plus/test";
import {
  buildWranglerTriggersDeployArgs,
  buildWranglerVersionDeployArgs,
  buildWranglerVersionUploadArgs,
  parseVersionId,
  parseWorkersDevUrl,
  parseWranglerVersionUploadOutput,
} from "../packages/cloudflare/src/version-deploy.js";

describe("Cloudflare Wrangler version deployment helpers", () => {
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

  it("builds non-interactive version deploy args for the uploaded version", () => {
    expect(buildWranglerVersionDeployArgs("095f00a7-23a7-43b7-a227-e4c97cab5f22", {})).toEqual({
      args: ["versions", "deploy", "095f00a7-23a7-43b7-a227-e4c97cab5f22@100%", "--yes"],
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
});
