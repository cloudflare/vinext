import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

describe("Next.js deploy harness logging", () => {
  it("materializes workspace dependencies required by the local vinext package", () => {
    const repoRoot = path.resolve(".");
    const script = fs.readFileSync(path.join(repoRoot, "scripts/e2e-deploy.sh"), "utf8");
    const injection = script.match(
      /node <<'EOF' >> "\$\{BUILD_LOG\}" 2>&1\n([\s\S]*?)\nEOF\n/,
    )?.[1];
    expect(injection).toBeDefined();

    const tempRoot = fs.mkdtempSync(path.join(process.cwd(), ".e2e-deploy-package-test-"));
    try {
      const workspaceRoot = path.join(tempRoot, "workspace");
      const appRoot = path.join(tempRoot, "app");
      fs.mkdirSync(appRoot, { recursive: true });
      fs.cpSync(path.join(repoRoot, "package.json"), path.join(workspaceRoot, "package.json"));
      fs.cpSync(
        path.join(repoRoot, "pnpm-workspace.yaml"),
        path.join(workspaceRoot, "pnpm-workspace.yaml"),
      );

      for (const packageName of ["vinext", "cloudflare", "types"]) {
        const packageRoot = path.join(workspaceRoot, "packages", packageName);
        fs.mkdirSync(packageRoot, { recursive: true });
        fs.cpSync(
          path.join(repoRoot, "packages", packageName, "package.json"),
          path.join(packageRoot, "package.json"),
        );
      }
      fs.mkdirSync(path.join(workspaceRoot, "packages/vinext/dist"), { recursive: true });
      fs.mkdirSync(path.join(workspaceRoot, "packages/cloudflare/dist"), { recursive: true });
      fs.mkdirSync(path.join(workspaceRoot, "packages/types/next"), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceRoot, "packages/types/next/index.d.ts"),
        'declare module "next" {}\n',
      );
      fs.writeFileSync(path.join(appRoot, "package.json"), '{"name":"fixture"}\n');

      execFileSync(process.execPath, ["-e", injection!], {
        cwd: appRoot,
        env: { ...process.env, VINEXT_DIR: workspaceRoot },
        stdio: "pipe",
      });

      const localVinext = JSON.parse(
        fs.readFileSync(path.join(appRoot, ".vinext-local-package/package.json"), "utf8"),
      );
      const localCloudflare = JSON.parse(
        fs.readFileSync(
          path.join(appRoot, ".vinext-local-cloudflare-package/package.json"),
          "utf8",
        ),
      );
      const localTypes = JSON.parse(
        fs.readFileSync(path.join(appRoot, ".vinext-local-types-package/package.json"), "utf8"),
      );
      expect(localVinext.dependencies["@vinext/types"]).toBe("file:../.vinext-local-types-package");
      expect(localCloudflare.peerDependencies.vinext).toBe("file:../.vinext-local-package");
      expect(localTypes.name).toBe("@vinext/types");
      expect(fs.existsSync(path.join(appRoot, ".vinext-local-types-package/next/index.d.ts"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("initializes fixtures for the Node deployment platform", () => {
    const script = fs.readFileSync(path.resolve("scripts/e2e-deploy.sh"), "utf8");

    expect(script).toContain('"${VINEXT_BIN}" init --platform=node --skip-check --force');
  });

  it("runs the installed vinext binary directly after pnpm install", () => {
    const script = fs.readFileSync(path.resolve("scripts/e2e-deploy.sh"), "utf8");

    expect(script).toContain('VINEXT_BIN="./node_modules/.bin/vinext"');
    expect(script).toContain('if [ ! -x "${VINEXT_BIN}" ]; then');
    expect(script).toContain('"${VINEXT_BIN}" build --prerender-all');
    expect(script).toContain('"${VINEXT_BIN}" start --port "${PORT}" --hostname 127.0.0.1');
    expect(script).not.toContain("run_pnpm exec vinext");
  });

  it("normalizes non-pnpm packageManager pins before pnpm install", () => {
    const script = fs.readFileSync(path.resolve("scripts/e2e-deploy.sh"), "utf8");

    expect(script).toContain(
      "originalPackageManager && !originalPackageManager.startsWith('pnpm@')",
    );
    expect(script).toContain("pkg.packageManager = harnessPackageManager");
    expect(script).toContain("for vinext e2e deploy harness pnpm install");
  });

  it("removes install-time deprecation noise from application cliOutput", () => {
    const script = fs.readFileSync(path.resolve("scripts/e2e-deploy.sh"), "utf8");

    expect(script).toContain('"${VINEXT_DIR}/scripts/filter-e2e-install-log.sh"');
    expect(script).toContain('>> "${BUILD_LOG}"');

    const output = execFileSync("bash", ["scripts/filter-e2e-install-log.sh"], {
      input:
        "(node:8211) [DEP0169] DeprecationWarning: `url.parse()` is deprecated\n" +
        "(Use `node --trace-deprecation ...` to show where the warning was created)\n" +
        "WARN 1 deprecated subdependencies found: tsconfck@3.1.6\n" +
        "Progress: resolved 370, reused 298, downloaded 0, added 292, done\n" +
        "Application warning: keep this diagnostic\n",
      encoding: "utf8",
    });

    expect(output).toBe(
      "Progress: resolved 370, reused 298, downloaded 0, added 292, done\n" +
        "Application warning: keep this diagnostic\n",
    );
  });

  it("preserves matching diagnostics from application lifecycle scripts", () => {
    const output = execFileSync("bash", ["scripts/filter-e2e-install-log.sh"], {
      input:
        "WARN 1 deprecated subdependencies found: tsconfck@3.1.6\n" +
        "> application@1.0.0 postinstall /tmp/application\n" +
        "> node postinstall.js\n" +
        "(node:9211) [DEP0169] DeprecationWarning: `url.parse()` is deprecated\n" +
        "(Use `node --trace-deprecation ...` to show where the warning was created)\n" +
        "1 deprecated subdependencies found: application-owned diagnostic\n" +
        "Application install error: keep this diagnostic\n" +
        "\n" +
        "(node:9212) [DEP0169] DeprecationWarning: `url.parse()` is deprecated\n" +
        "2 deprecated subdependencies found: later application diagnostic\n" +
        "Done in 1.2s using pnpm v11.1.1\n" +
        "WARN 2 deprecated subdependencies found: harness@1.0.0\n",
      encoding: "utf8",
    });

    expect(output).toBe(
      "> application@1.0.0 postinstall /tmp/application\n" +
        "> node postinstall.js\n" +
        "(node:9211) [DEP0169] DeprecationWarning: `url.parse()` is deprecated\n" +
        "(Use `node --trace-deprecation ...` to show where the warning was created)\n" +
        "1 deprecated subdependencies found: application-owned diagnostic\n" +
        "Application install error: keep this diagnostic\n" +
        "\n" +
        "(node:9212) [DEP0169] DeprecationWarning: `url.parse()` is deprecated\n" +
        "2 deprecated subdependencies found: later application diagnostic\n" +
        "Done in 1.2s using pnpm v11.1.1\n",
    );
  });
});
