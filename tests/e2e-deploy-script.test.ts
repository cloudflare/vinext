import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

describe("Next.js deploy harness logging", () => {
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
    expect(script).toContain("for vinext deploy harness pnpm install");
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
