import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runInjectOnlyDeployFixture(nextConfigSource: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-e2e-deploy-script-"));

  try {
    const vinextDir = path.join(root, "vinext");
    const nextjsDir = path.join(root, "next.js");
    const appDir = path.join(root, "app");

    fs.mkdirSync(path.join(vinextDir, "packages", "vinext", "dist"), { recursive: true });
    fs.mkdirSync(path.join(vinextDir, "packages", "cloudflare", "dist"), { recursive: true });
    fs.writeFileSync(path.join(vinextDir, "packages", "vinext", "dist", "cli.js"), "");
    fs.writeFileSync(
      path.join(vinextDir, "pnpm-workspace.yaml"),
      [
        "catalog:",
        "  vite: ^8.0.0",
        '  "@vitejs/plugin-react": ^5.0.0',
        '  "@vitejs/plugin-rsc": ^0.0.0',
        "  react-server-dom-webpack: ^19.0.0",
        '  "@mdx-js/rollup": ^3.0.0',
        '  "@mdx-js/react": ^3.0.0',
        "  ipaddr.js: ^2.2.0",
        "",
      ].join("\n"),
    );
    writeJson(path.join(vinextDir, "package.json"), {
      name: "vinext-monorepo",
      private: true,
      packageManager: "pnpm@11.1.1",
    });
    writeJson(path.join(vinextDir, "packages", "vinext", "package.json"), {
      name: "vinext",
      version: "0.0.0-test",
      type: "module",
      bin: { vinext: "dist/cli.js" },
      exports: {},
    });
    writeJson(path.join(vinextDir, "packages", "cloudflare", "package.json"), {
      name: "@vinext/cloudflare",
      version: "0.0.0-test",
      type: "module",
      exports: {},
    });

    writeJson(path.join(nextjsDir, "package.json"), {
      name: "nextjs-workspace",
      devDependencies: {
        "react-experimental-builtin": "npm:react@0.0.0-experimental-test-20260701",
        "react-dom-experimental-builtin": "npm:react-dom@0.0.0-experimental-test-20260701",
        "react-server-dom-webpack-experimental":
          "file:packages/next/src/compiled/react-server-dom-webpack-experimental",
      },
    });

    fs.mkdirSync(path.join(appDir, "app"), { recursive: true });
    writeJson(path.join(appDir, "package.json"), {
      name: "experimental-react-app",
      version: "0.0.0-test",
    });
    fs.writeFileSync(path.join(appDir, "next.config.js"), nextConfigSource);

    execFileSync("bash", [path.resolve("scripts/e2e-deploy.sh")], {
      cwd: appDir,
      env: {
        ...process.env,
        NEXTJS_DIR: nextjsDir,
        VINEXT_DIR: vinextDir,
        VINEXT_E2E_DEPLOY_INJECT_ONLY: "1",
      },
      encoding: "utf8",
    });

    return {
      appPackageJson: JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")),
      nextjsDir,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

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
    expect(script).toContain("for vinext e2e deploy harness pnpm install");
  });

  it("injects Next's experimental React alias packages when fixtures opt in", () => {
    const deployScript = fs.readFileSync(path.resolve("scripts/e2e-deploy.sh"), "utf8");
    const suiteScript = fs.readFileSync(path.resolve("scripts/run-nextjs-deploy-suite.sh"), "utf8");
    const workflow = fs.readFileSync(
      path.resolve(".github/workflows/nextjs-deploy-suite.yml"),
      "utf8",
    );
    const deployShard = workflow.slice(
      workflow.indexOf("- name: Run deploy shard"),
      workflow.indexOf("- name: Upload test results"),
    );

    expect(suiteScript).toContain("export NEXTJS_DIR");
    expect(deployShard).toContain("NEXTJS_DIR: ${{ github.workspace }}/next.js");
    expect(deployScript).toContain("needsExperimentalReactDeps");
    expect(deployScript).toContain("nextDependencySpecFor");
    expect(deployScript).toContain("experimentalReactDependencySpecFor");
    expect(deployScript).toContain("react-experimental-builtin");
    expect(deployScript).toContain("react-dom-experimental-builtin");
    expect(deployScript).toContain("react-server-dom-webpack-experimental");
    expect(deployScript).toContain("taint|transitionIndicator|gestureTransition");
    expect(deployScript).not.toContain("taint|blockingSSR|transitionIndicator|gestureTransition");
  });

  it("injects npm react-server-dom-webpack experimental deps instead of Next's compiled copy", () => {
    const { appPackageJson } = runInjectOnlyDeployFixture(
      "module.exports = { experimental: { taint: true } }\n",
    );

    expect(appPackageJson.devDependencies["react-server-dom-webpack-experimental"]).toBe(
      "npm:react-server-dom-webpack@0.0.0-experimental-test-20260701",
    );
    expect(appPackageJson.devDependencies["react-experimental-builtin"]).toBe(
      "npm:react@0.0.0-experimental-test-20260701",
    );
    expect(appPackageJson.devDependencies.vite).toBe("^8.0.0");
  });

  it("detects quoted experimental React config keys before injecting deps", () => {
    const { appPackageJson } = runInjectOnlyDeployFixture(
      'module.exports = { experimental: { "taint": true } }\n',
    );

    expect(appPackageJson.devDependencies["react-experimental-builtin"]).toBeDefined();
    expect(appPackageJson.devDependencies["react-dom-experimental-builtin"]).toBeDefined();
    expect(appPackageJson.devDependencies["react-server-dom-webpack-experimental"]).toBeDefined();
  });

  it("does not inject experimental React deps for experimental.blockingSSR", () => {
    const { appPackageJson } = runInjectOnlyDeployFixture(
      "module.exports = { experimental: { blockingSSR: true } }\n",
    );

    expect(appPackageJson.devDependencies["react-experimental-builtin"]).toBeUndefined();
    expect(appPackageJson.devDependencies["react-dom-experimental-builtin"]).toBeUndefined();
    expect(appPackageJson.devDependencies["react-server-dom-webpack-experimental"]).toBeUndefined();
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
