import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  parseCfDeploymentStatusOutput,
  buildCfVersionUploadArgs,
  buildWranglerDeploymentsStatusArgs,
  buildWranglerTriggersDeployArgs,
  buildWranglerVersionDeployArgs,
  buildWranglerVersionUploadArgs,
  parseUploadedWorkerName,
  parseVersionId,
  parseWorkersDevUrl,
  parseWranglerDeploymentStatusOutput,
  parseWranglerVersionUploadOutput,
  runCfVersionUpload,
  runCfDeploymentStatus,
  runCfVersionDeploy,
  runCfTriggersDeploy,
  runWranglerDeploymentStatus,
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

  it("records the version message and tag on uploads", () => {
    const annotations = { message: "Fix the header", tag: "abc123" };
    expect(buildWranglerVersionUploadArgs(annotations)).toEqual({
      args: ["versions", "upload", "--message=Fix the header", "--tag=abc123"],
      env: undefined,
    });
    expect(buildCfVersionUploadArgs({ ...annotations, previewAlias: "warm-build" })).toEqual({
      args: [
        "workers",
        "versions",
        "create",
        "--prebuilt",
        "--preview-alias",
        "warm-build",
        "--message=Fix the header",
        "--tag=abc123",
      ],
      mode: undefined,
    });
  });

  it("builds cf Build Output version upload args", () => {
    expect(buildCfVersionUploadArgs({})).toEqual({
      args: ["workers", "versions", "create", "--prebuilt"],
      mode: undefined,
    });
    expect(buildCfVersionUploadArgs({ env: "staging", previewAlias: "warm-build" })).toEqual({
      args: [
        "workers",
        "versions",
        "create",
        "--prebuilt",
        "--mode",
        "staging",
        "--preview-alias",
        "warm-build",
      ],
      mode: "staging",
    });
  });

  it("uses cf for a Build Output version upload", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cf-upload-"));
    const configPath = path.join(root, ".cloudflare/output/v0/workers/default/worker.config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ name: "my-worker" }));
    const execute = vi.fn(() => ({
      status: 0,
      stdout: "",
      stderr: `
      Worker Version ID: 095f00a7-23a7-43b7-a227-e4c97cab5f22
      Version Preview URL: https://095f00a7-my-worker.example.workers.dev
    `,
    }));

    expect(runCfVersionUpload(root, {}, execute as never)).toMatchObject({
      versionId: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
      workerName: "my-worker",
      previewUrl: "https://095f00a7-my-worker.example.workers.dev",
    });
    expect(execute).toHaveBeenCalledWith(
      process.execPath,
      [path.join(root, "node_modules/cf/bin/cf"), "workers", "versions", "create", "--prebuilt"],
      expect.objectContaining({ cwd: root, shell: false }),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("with a cf process", () => {
    // cf writes its log, including `Worker Version ID:` and deployed URLs, to stderr and only
    // JSON results to stdout. These run a stand-in cf package so the real streams are split.
    function createCfProject(script: string): string {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cf-process-"));
      const configPath = path.join(
        root,
        ".cloudflare/output/v0/workers/default/worker.config.json",
      );
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ name: "my-worker" }));
      const cfDir = path.join(root, "node_modules/cf");
      fs.mkdirSync(path.join(cfDir, "bin"), { recursive: true });
      fs.writeFileSync(
        path.join(cfDir, "package.json"),
        JSON.stringify({ name: "cf", bin: { cf: "bin/cf" } }),
      );
      fs.writeFileSync(path.join(cfDir, "bin/cf"), script);
      return root;
    }

    it("reads the uploaded version from cf's stderr", () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const root = createCfProject(
        `process.stderr.write(${JSON.stringify(
          [
            "│  Uploaded my-worker (3.84 sec)",
            "│  Worker Version ID: 10020de7-db25-45f6-9a4e-455d64ff587c",
            "│  Version Preview URL: https://10020de7-my-worker.example.workers.dev",
            "",
          ].join("\n"),
        )});`,
      );
      try {
        expect(runCfVersionUpload(root, {})).toMatchObject({
          versionId: "10020de7-db25-45f6-9a4e-455d64ff587c",
          previewUrl: "https://10020de7-my-worker.example.workers.dev",
          workerName: "my-worker",
        });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("reads the deployed URL from cf's stderr when applying triggers", () => {
      const root = createCfProject(
        `process.stderr.write("│  Deployed my-worker triggers\\n│    https://my-worker.example.workers.dev\\n");`,
      );
      try {
        expect(runCfTriggersDeploy(root, {}).deployedUrl).toBe(
          "https://my-worker.example.workers.dev",
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it.each([
      ["custom domain", "│", "shop.example.com (custom domain)"],
      ["catch-all route", "│", "shop.example.com/* (zone name: example.com)"],
      // FORCE_COLOR in the environment makes cf color its gutter even when stderr is a pipe.
      ["custom domain", "\u001B[90m│\u001B[39m", "shop.example.com (custom domain)"],
    ])(
      "prefers a %s over workers.dev in cf's %j-prefixed triggers log",
      (_label, gutter, target) => {
        const root = createCfProject(
          `process.stderr.write(${JSON.stringify(
            [
              `${gutter}  Deployed my-worker triggers (0.41 sec)`,
              `${gutter}    https://my-worker.example.workers.dev`,
              `${gutter}    ${target}`,
              "",
            ].join("\n"),
          )});`,
        );
        try {
          expect(runCfTriggersDeploy(root, {}).deployedUrl).toBe("https://shop.example.com");
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it.each([
      ["[production: disabled]", "https://my-worker.example.workers.dev"],
      ["[production: enabled, previews: disabled]", "https://shop.example.com"],
    ])("honors a cf custom domain flagged %s", (flags, expected) => {
      const root = createCfProject(
        `process.stderr.write(${JSON.stringify(
          [
            "│  Deployed my-worker triggers (0.41 sec)",
            "│    https://my-worker.example.workers.dev",
            `│    shop.example.com (custom domain) ${flags}`,
            "",
          ].join("\n"),
        )});`,
      );
      try {
        expect(runCfTriggersDeploy(root, {}).deployedUrl).toBe(expected);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("parses the deployment list from cf's stdout only", () => {
      const deployments = {
        deployments: [
          {
            id: "current",
            versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
          },
        ],
      };
      const root = createCfProject(
        `process.stderr.write("Using account: Example\\n"); process.stdout.write(${JSON.stringify(
          JSON.stringify(deployments),
        )});`,
      );
      try {
        expect(runCfDeploymentStatus(root, { name: "my-worker" })).toMatchObject({
          deploymentId: "current",
          versions: [{ versionId: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("reports a missing Worker from cf's stderr when the upload fails", () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const root = createCfProject(
        `process.stderr.write("You cannot upload a new version of a Worker that does not yet exist.\\n"); process.exitCode = 1;`,
      );
      try {
        expect(() => runCfVersionUpload(root, {})).toThrow(
          "Version upload needs an existing Cloudflare Worker",
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("keeps cf's output on an execution error such as a full buffer", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cf-upload-"));
    const configPath = path.join(root, ".cloudflare/output/v0/workers/default/worker.config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ name: "my-worker" }));
    const execute = vi.fn(() => ({
      error: Object.assign(new Error("spawnSync node ENOBUFS"), { code: "ENOBUFS" }),
      status: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "cannot upload a new version of a Worker that does not yet exist\n",
    }));

    try {
      expect(() => runCfVersionUpload(root, {}, execute as never)).toThrow(
        "Version upload needs an existing Cloudflare Worker",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the Build Output Worker name before uploading", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cf-upload-"));
    const execute = vi.fn();

    expect(() => runCfVersionUpload(root, {}, execute as never)).toThrow(
      "Could not read the generated Cloudflare Build Output config",
    );
    expect(execute).not.toHaveBeenCalled();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    "│  Uploaded my-worker (3.55 sec)",
    "\u001B[32m|  Uploaded my-worker (3.55 sec)\u001B[0m",
  ])("parses Wrangler's uploaded Worker name from %j", (output) => {
    expect(parseUploadedWorkerName(output)).toBe("my-worker");
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

  it("hides raw Wrangler upload output by default and shows it in verbose mode", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const output = JSON.stringify({
      version: { id: "095f00a7-23a7-43b7-a227-e4c97cab5f22" },
    });
    const execute = vi.fn(() => output);

    runWranglerVersionUpload("/tmp/app", {}, execute as never);
    expect(log).not.toHaveBeenCalledWith(`  ${output}`);
    expect(log).toHaveBeenCalledWith("  Worker version ID: 095f00a7-23a7-43b7-a227-e4c97cab5f22");

    log.mockClear();
    runWranglerVersionUpload("/tmp/app", { verbose: true }, execute as never);
    expect(log).toHaveBeenCalledWith(`  ${output}`);
  });

  it("keeps deployment-status internals quiet unless verbose output is requested", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const output = JSON.stringify({
      id: "deployment-1",
      versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
    });
    const execute = vi.fn(() => output);

    runWranglerDeploymentStatus("/tmp/app", {}, execute as never);
    expect(log).not.toHaveBeenCalled();

    runWranglerDeploymentStatus("/tmp/app", { verbose: true }, execute as never);
    expect(log).toHaveBeenCalledWith("\n  Reading current Worker deployment...");
    expect(log).toHaveBeenCalledWith(`  ${output}`);
  });

  it("asks for an initial normal deploy when the Worker does not exist yet", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const execute = vi.fn(() => {
      throw Object.assign(new Error("Command failed"), {
        stderr:
          "✘ [ERROR] You cannot upload a new version of a Worker that does not yet exist. Please run the `deploy` command first.",
      });
    });

    expect(() => runWranglerVersionUpload("/tmp/app", {}, execute as never)).toThrow(
      "Run `vinext-cloudflare deploy` once normally to create the Worker",
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

  it("prefers Wrangler's labeled version ID over UUIDs in uploaded asset paths", () => {
    const output = `
      + /_next/static/82859cda-4cfe-4924-96da-fe471138612a/_buildManifest.js
      Uploaded rsc-prewarm-32362416100 (4.16 sec)
      Worker Version ID: 7283300a-90b0-45d6-ba08-7c4b76797f38
      Version Preview URL: https://7283300a-rsc-prewarm-32362416100.vinext.workers.dev
    `;

    expect(parseWranglerVersionUploadOutput(output)).toMatchObject({
      versionId: "7283300a-90b0-45d6-ba08-7c4b76797f38",
      workerName: "rsc-prewarm-32362416100",
      previewUrl: "https://7283300a-rsc-prewarm-32362416100.vinext.workers.dev",
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
          id: "deployment-1",
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        }),
      ),
    ).toMatchObject({
      deploymentId: "deployment-1",
      versions: [{ versionId: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
    });
  });

  it("reads the first cf deployment, not an older entry", () => {
    const current = {
      id: "current",
      versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
    };
    expect(
      parseCfDeploymentStatusOutput(
        JSON.stringify({
          deployments: [current, { id: "older", versions: [] }],
        }),
      ),
    ).toMatchObject({
      deploymentId: "current",
      versions: [{ versionId: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
    });
    expect(() => parseCfDeploymentStatusOutput('{"deployments":[]}')).toThrow("active deployment");
  });

  it("uses cf for status, percentage deployments, and prebuilt triggers", () => {
    const execute = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({
        deployments: [
          {
            id: "current",
            versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
          },
        ],
      }),
      stderr: "",
    }));
    const root = "/tmp/app";
    const bin = path.join(root, "node_modules/cf/bin/cf");
    expect(runCfDeploymentStatus(root, { name: "my-worker" }, execute as never).deploymentId).toBe(
      "current",
    );
    expect(execute).toHaveBeenCalledWith(
      process.execPath,
      [bin, "workers", "deployments", "list", "--worker", "my-worker"],
      expect.objectContaining({ cwd: root, shell: false }),
    );

    runCfVersionDeploy(
      root,
      [
        { versionId: "11111111-1111-4111-8111-111111111111", percentage: 100 },
        { versionId: "22222222-2222-4222-8222-222222222222", percentage: 0 },
      ],
      { name: "my-worker" },
      "stage",
      execute as never,
    );
    expect(execute).toHaveBeenCalledWith(
      process.execPath,
      [
        bin,
        "workers",
        "deployments",
        "create",
        "--worker",
        "my-worker",
        "--strategy",
        "percentage",
        "--versions",
        JSON.stringify([
          { version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 },
          { version_id: "22222222-2222-4222-8222-222222222222", percentage: 0 },
        ]),
      ],
      expect.objectContaining({ cwd: root, shell: false }),
    );

    runCfTriggersDeploy(root, {}, execute as never);
    expect(execute).toHaveBeenCalledWith(
      process.execPath,
      [bin, "workers", "triggers", "deploy", "--prebuilt"],
      expect.objectContaining({ cwd: root, shell: false }),
    );

    runCfDeploymentStatus(root, { name: "my-worker", env: "staging" }, execute as never);
    expect(execute).toHaveBeenCalledWith(
      process.execPath,
      [bin, "workers", "deployments", "list", "--worker", "my-worker", "--mode", "staging"],
      expect.objectContaining({ cwd: root, shell: false }),
    );
    runCfTriggersDeploy(root, { env: "staging" }, execute as never);
    expect(execute).toHaveBeenCalledWith(
      process.execPath,
      [bin, "workers", "triggers", "deploy", "--prebuilt", "--mode", "staging"],
      expect.objectContaining({ cwd: root, shell: false }),
    );
  });
});
