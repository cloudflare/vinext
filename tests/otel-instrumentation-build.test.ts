import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createBuilder } from "vite";
import { afterAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const sentryRequire = createRequire(require.resolve("@sentry/nextjs/package.json"));

function packageRoot(specifier: string): string {
  return path.resolve(path.dirname(sentryRequire.resolve(specifier)), "../..");
}

describe("OpenTelemetry production instrumentation", () => {
  const root = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-otel-build-"));

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Regression for the OpenTelemetry setup used by Next.js:
  // test/e2e/app-dir/cache-components-allow-otel-spans/cache-components-allow-otel-spans.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/cache-components-allow-otel-spans/cache-components-allow-otel-spans.test.ts
  it("shares the installed import-in-the-middle registry with the ESM loader", async () => {
    fs.mkdirSync(path.join(root, "app", "probe"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", "@opentelemetry"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", "otel-probe-package"), { recursive: true });

    for (const packageName of ["api", "instrumentation"]) {
      fs.symlinkSync(
        packageRoot(`@opentelemetry/${packageName}`),
        path.join(root, "node_modules", "@opentelemetry", packageName),
        "junction",
      );
    }

    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "otel-instrumentation-build-test",
        private: true,
        type: "module",
        dependencies: {
          "@opentelemetry/api": "1.9.1",
          "@opentelemetry/instrumentation": "0.214.0",
          "otel-probe-package": "1.0.0",
        },
      }),
    );
    fs.writeFileSync(
      path.join(root, "node_modules", "otel-probe-package", "package.json"),
      JSON.stringify({
        name: "otel-probe-package",
        version: "1.0.0",
        type: "module",
        exports: "./index.js",
      }),
    );
    fs.writeFileSync(
      path.join(root, "node_modules", "otel-probe-package", "index.js"),
      `export const value = "loaded";\n`,
    );
    fs.writeFileSync(
      path.join(root, "app", "layout.tsx"),
      `export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n`,
    );
    fs.writeFileSync(
      path.join(root, "app", "probe", "route.ts"),
      `export async function GET() {
  await import("otel-probe-package");
  return new Response(globalThis.__OTEL_ESM_INTERCEPTED__ ? "intercepted" : "missed");
}\n`,
    );
    fs.writeFileSync(
      path.join(root, "instrumentation.ts"),
      `import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";

class ProbeInstrumentation extends InstrumentationBase {
  constructor() {
    super("otel-probe-instrumentation", "1.0.0");
  }

  init() {
    return new InstrumentationNodeModuleDefinition(
      "otel-probe-package",
      ["*"],
      (moduleExports) => {
        globalThis.__OTEL_ESM_INTERCEPTED__ = true;
        return moduleExports;
      },
    );
  }
}

const instrumentation = new ProbeInstrumentation();

export function register() {
  instrumentation.enable();
}\n`,
    );
    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      `export default { serverExternalPackages: ["otel-probe-package"] };\n`,
    );

    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [vinext({ appDir: root })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const runnerPath = path.join(root, "run-built-app.mjs");
    fs.writeFileSync(
      runnerPath,
      `const { default: handleRequest } = await import("./dist/server/index.js");
const response = await handleRequest(new Request("http://localhost/probe"));
if (!(response instanceof Response)) throw new Error("Expected a Response");
process.stdout.write(await response.text());\n`,
    );

    const { stdout, stderr } = await execFileAsync(process.execPath, [runnerPath], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "production",
        NODE_OPTIONS: "--no-warnings --loader=@opentelemetry/instrumentation/hook.mjs",
      },
      timeout: 30_000,
    });

    expect(stderr).toBe("");
    expect(stdout).toBe("intercepted");
  }, 60_000);
});
