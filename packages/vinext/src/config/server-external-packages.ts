import fs from "node:fs";
import path from "pathslash";

// Keep in sync with Next.js 16.2.6:
// packages/next/src/lib/server-external-packages.jsonc
const DEFAULT_SERVER_EXTERNAL_PACKAGES = [
  "@alinea/generated",
  "@appsignal/nodejs",
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-presigned-post",
  "@blockfrost/blockfrost-js",
  "@highlight-run/node",
  "@huggingface/transformers",
  "@jpg-store/lucid-cardano",
  "@libsql/client",
  "@mikro-orm/core",
  "@mikro-orm/knex",
  "@node-rs/argon2",
  "@node-rs/bcrypt",
  "@prisma/client",
  "@react-pdf/renderer",
  "@sentry/profiling-node",
  "@sparticuz/chromium",
  "@sparticuz/chromium-min",
  "@statsig/statsig-node-core",
  "@swc/core",
  "@xenova/transformers",
  "@zenstackhq/runtime",
  "argon2",
  "autoprefixer",
  "aws-crt",
  "bcrypt",
  "better-sqlite3",
  "canvas",
  "chromadb-default-embed",
  "config",
  "cpu-features",
  "cypress",
  "dd-trace",
  "eslint",
  "express",
  "firebase-admin",
  "htmlrewriter",
  "import-in-the-middle",
  "isolated-vm",
  "jest",
  "jsdom",
  "keyv",
  "libsql",
  "mdx-bundler",
  "mongodb",
  "mongoose",
  "newrelic",
  "next-mdx-remote",
  "next-seo",
  "node-cron",
  "node-pty",
  "node-web-audio-api",
  "onnxruntime-node",
  "oslo",
  "pg",
  "pino",
  "pino-pretty",
  "pino-roll",
  "playwright",
  "playwright-core",
  "postcss",
  "prettier",
  "prisma",
  "puppeteer",
  "puppeteer-core",
  "ravendb",
  "require-in-the-middle",
  "rimraf",
  "sharp",
  "shiki",
  "sqlite3",
  "thread-stream",
  "ts-morph",
  "ts-node",
  "typescript",
  "vscode-oniguruma",
  "webpack",
  "websocket",
  "zeromq",
] as const;

/**
 * OpenTelemetry's instrumentation packages must keep their native package
 * boundaries. In particular, `import-in-the-middle` shares a hook registry
 * between its Node loader and the Hook class imported by OpenTelemetry.
 * Bundling the latter creates a second registry and silently disables ESM
 * instrumentation.
 *
 * Externalizing the project's direct OpenTelemetry dependencies also keeps
 * their transitive IITM/RITM imports resolving from the owning package under
 * strict pnpm, instead of leaving an unresolvable bare import in dist/server.
 */
export function findOpenTelemetryPackages(root: string): string[] {
  const packageJsonPath = path.join(root, "package.json");
  let packageJson: Record<string, unknown>;

  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return [];
  }

  const packageNames = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = packageJson[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }
    for (const packageName of Object.keys(dependencies)) {
      if (packageName.startsWith("@opentelemetry/")) {
        packageNames.add(packageName);
      }
    }
  }

  return [...packageNames];
}

export function mergeServerExternalPackages(
  userPackages: readonly string[] = [],
  transpilePackages: readonly string[] = [],
  additionalDefaults: readonly string[] = [],
): string[] {
  const transpiled = new Set(transpilePackages);
  const conflicts = userPackages.filter((name) => transpiled.has(name));
  if (conflicts.length > 0) {
    throw new Error(
      `The packages specified in the 'transpilePackages' conflict with the 'serverExternalPackages': ${conflicts.join(", ")}`,
    );
  }
  const defaults = [...DEFAULT_SERVER_EXTERNAL_PACKAGES, ...additionalDefaults].filter(
    (name) => !transpiled.has(name),
  );
  return [...new Set([...defaults, ...userPackages])];
}
