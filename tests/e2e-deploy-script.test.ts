import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

describe("Next.js deploy harness logging", () => {
  it("initializes fixtures for the Node deployment platform", () => {
    const script = fs.readFileSync(path.resolve("scripts/e2e-deploy.sh"), "utf8");

    expect(script).toContain("vinext init --platform=node --skip-check --force");
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
