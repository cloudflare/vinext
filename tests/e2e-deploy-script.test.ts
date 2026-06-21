import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

describe("Next.js deploy harness logging", () => {
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
});
