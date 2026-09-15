import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createBuilder } from "vite";
import { afterAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  getReportedSentryTransactions,
  recordSentryEnvelope,
  resetSentryReports,
} from "./fixtures/sentry-test-state.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

function packageRoot(packageName: string): string {
  return path.dirname(require.resolve(`${packageName}/package.json`));
}

function linkPackage(root: string, packageName: string): void {
  const target = path.join(root, "node_modules", ...packageName.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(packageRoot(packageName), target, "junction");
}

describe("Sentry Node production instrumentation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-sentry-node-build-"));

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Existing Next.js applications configure Sentry through instrumentation.ts
  // and withSentryConfig. Vinext must preserve that shape after `next` is removed.
  // Ordering ported from Next.js:
  // test/e2e/app-dir/instrumentation-order/instrumentation-order.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/instrumentation-order/instrumentation-order.test.ts
  it("starts an unchanged Sentry app without next or direct OpenTelemetry dependencies", async () => {
    resetSentryReports();
    for (const packageName of ["@sentry/nextjs", "react", "react-dom"]) {
      linkPackage(root, packageName);
    }

    fs.mkdirSync(path.join(root, "app", "trace"), { recursive: true });
    fs.mkdirSync(path.join(root, "pages"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "sentry-node-vinext-app",
        private: true,
        type: "module",
        dependencies: {
          "@sentry/nextjs": "10.62.0",
          react: "19.2.7",
          "react-dom": "19.2.7",
        },
      }),
    );
    const appRequire = createRequire(path.join(root, "package.json"));
    expect(() => appRequire.resolve("next/package.json")).toThrow();
    expect(() => appRequire.resolve("@opentelemetry/api")).toThrow();

    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      `import { withSentryConfig } from "@sentry/nextjs";
export default withSentryConfig({}, { silent: true, telemetry: false });\n`,
    );
    fs.writeFileSync(
      path.join(root, "instrumentation.ts"),
      `import * as Sentry from "@sentry/nextjs";
export async function register() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 1 });
  globalThis.__SENTRY_REGISTERED__ = Boolean(Sentry.getClient());
}
export const onRequestError = Sentry.captureRequestError;\n`,
    );
    fs.writeFileSync(
      path.join(root, "app", "layout.tsx"),
      `import * as Sentry from "@sentry/nextjs";
globalThis.__SENTRY_LAYOUT_SAW_REGISTERED__ = globalThis.__SENTRY_REGISTERED__ === true;
export default function Layout({ children }) { return <html><body>{children}</body></html>; }
export const dynamic = "force-dynamic";
void Sentry;\n`,
    );
    fs.writeFileSync(
      path.join(root, "app", "trace", "page.tsx"),
      `import * as Sentry from "@sentry/nextjs";
export const dynamic = "force-dynamic";
export default async function Page() {
  const value = await Sentry.startSpan({ name: "node-app-span", op: "test" }, async () => "ok");
  return <main>{globalThis.__SENTRY_LAYOUT_SAW_REGISTERED__ ? value : "registered-too-late"}</main>;
}\n`,
    );
    fs.writeFileSync(
      path.join(root, "pages", "pages-trace.tsx"),
      `import * as Sentry from "@sentry/nextjs";
globalThis.__SENTRY_PAGES_SAW_REGISTERED__ = globalThis.__SENTRY_REGISTERED__ === true;
export async function getServerSideProps() {
  const value = await Sentry.startSpan({ name: "node-pages-span", op: "test" }, async () => "ok");
  return { props: { value } };
}
export default function Page({ value }) {
  return <main>{globalThis.__SENTRY_PAGES_SAW_REGISTERED__ ? value : "registered-too-late"}</main>;
}\n`,
    );

    const envelopes: string[] = [];
    const collector = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const envelope = Buffer.concat(chunks).toString("utf8");
        envelopes.push(envelope);
        recordSentryEnvelope("1", envelope);
        response.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    const address = collector.address();
    if (!address || typeof address === "string") throw new Error("Expected collector address");

    try {
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
for (const pathname of ["/trace", "/pages-trace"]) {
  const response = await handleRequest(new Request("http://localhost" + pathname));
  if (!(response instanceof Response)) throw new Error("Expected a Response");
  process.stdout.write(await response.text());
}
await new Promise((resolve) => setTimeout(resolve, 750));\n`,
      );

      const { stdout, stderr } = await execFileAsync(process.execPath, [runnerPath], {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: "production",
          NODE_OPTIONS: "",
          SENTRY_DSN: `http://public@127.0.0.1:${address.port}/1`,
        },
        timeout: 30_000,
      });

      expect(stderr).toBe("");
      expect(stdout).toContain("ok");
      expect(stdout).not.toContain("registered-too-late");
      expect(envelopes.length).toBeGreaterThan(0);
      const transactions = getReportedSentryTransactions();
      expect(
        transactions.some((transaction) =>
          transaction.spans.some((span) => span.name === "node-app-span"),
        ),
      ).toBe(true);
      expect(
        transactions.some((transaction) =>
          transaction.spans.some((span) => span.name === "node-pages-span"),
        ),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        collector.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 60_000);
});
