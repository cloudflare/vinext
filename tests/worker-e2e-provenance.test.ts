import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseAst } from "vite";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MANIFEST_PATH = path.join(
  ROOT,
  "tests/e2e/cloudflare-workers/provenance/worker-fixture.v16.2.6.json",
);

type Snapshot = { path: string; sha256: string };

type ProvenanceManifest = {
  upstreamSuite: string;
  equivalentSuite: string;
  upstreamSuiteSnapshot: Snapshot;
  upstreamConfig: Snapshot & {
    upstreamPath: string;
    equivalentLocalFiles: string[];
    equivalence: string;
  };
  fixtureRoot: string;
  upstreamFixtureRoot: string;
  removed: string[];
  cases: Array<{ name: string; route: string; fixtures: string[] }>;
  commonFixtures: string[];
  byteExactFixturePaths: string[];
  sha256: Record<string, string>;
};

type AstNode = Record<string, unknown> & { type: string };

type TestCase = { name: string; body: AstNode };

function sha256(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function parseCases(sourceText: string, fileName: string): TestCase[] {
  const sourceFile = parseAst(sourceText, { lang: "ts" }, fileName);
  const cases: TestCase[] = [];

  function visit(value: unknown): void {
    if (!isAstNode(value)) return;
    const callee = value.callee;
    const args = value.arguments;
    if (value.type === "CallExpression" && isIdentifier(callee, "it") && Array.isArray(args)) {
      const name = args[0];
      const callback = args[1];
      if (
        isAstNode(name) &&
        name.type === "Literal" &&
        typeof name.value === "string" &&
        isAstNode(callback) &&
        callback.type === "ArrowFunctionExpression" &&
        isAstNode(callback.body) &&
        callback.body.type === "BlockStatement"
      ) {
        cases.push({ name: name.value, body: callback.body });
      }
    }

    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }

  visit(sourceFile);
  return cases;
}

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && "type" in value;
}

function isIdentifier(value: unknown, name: string): boolean {
  return isAstNode(value) && value.type === "Identifier" && value.name === name;
}

function isBeforePageLoadOptions(value: unknown): boolean {
  if (!isAstNode(value) || value.type !== "ObjectExpression" || !Array.isArray(value.properties)) {
    return false;
  }
  const [property] = value.properties;
  return (
    value.properties.length === 1 &&
    isAstNode(property) &&
    property.type === "Property" &&
    property.shorthand === true &&
    isIdentifier(property.key, "beforePageLoad") &&
    isIdentifier(property.value, "beforePageLoad")
  );
}

function isNextBrowserCall(value: AstNode): boolean {
  const callee = value.callee;
  return (
    value.type === "CallExpression" &&
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    isIdentifier(callee.object, "next") &&
    isIdentifier(callee.property, "browser")
  );
}

function findBrowserRoute(value: unknown): string | undefined {
  if (isAstNode(value) && isNextBrowserCall(value) && Array.isArray(value.arguments)) {
    const route = value.arguments[0];
    if (isAstNode(route) && route.type === "Literal" && typeof route.value === "string") {
      return route.value;
    }
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const route = findBrowserRoute(item);
        if (route !== undefined) return route;
      }
    } else {
      const route = findBrowserRoute(child);
      if (route !== undefined) return route;
    }
  }
  return undefined;
}

const AST_METADATA = new Set(["start", "end", "loc", "range", "raw"]);

function normalizeBody(
  value: unknown,
  omitBeforePageLoad: boolean,
  state: { omissions: number },
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeBody(item, omitBeforePageLoad, state));
  }
  if (typeof value !== "object" || value === null) return value;

  const node = value as Record<string, unknown>;
  const entries = Object.entries(node)
    .filter(([key]) => !AST_METADATA.has(key))
    .sort(([left], [right]) => left.localeCompare(right));
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of entries) {
    if (
      key === "arguments" &&
      omitBeforePageLoad &&
      isAstNode(value) &&
      isNextBrowserCall(value) &&
      Array.isArray(child) &&
      child.length === 2 &&
      isBeforePageLoadOptions(child[1])
    ) {
      state.omissions++;
      normalized[key] = [normalizeBody(child[0], omitBeforePageLoad, state)];
    } else {
      normalized[key] = normalizeBody(child, omitBeforePageLoad, state);
    }
  }
  return normalized;
}

function normalizedBody(
  body: AstNode,
  omitBeforePageLoad: boolean,
): {
  body: unknown;
  omissions: number;
} {
  const state = { omissions: 0 };
  return { body: normalizeBody(body, omitBeforePageLoad, state), omissions: state.omissions };
}

const GENERATED_FIXTURE_ENTRIES = new Set([
  ".next",
  ".wrangler",
  "dist",
  "next-env.d.ts",
  "node_modules",
]);

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = (await readdir(directory, { withFileTypes: true })).filter(
    (entry) => prefix !== "" || !GENERATED_FIXTURE_ENTRIES.has(entry.name),
  );
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.posix.join(prefix, entry.name);
      return entry.isDirectory()
        ? listFiles(path.join(directory, entry.name), relativePath)
        : [relativePath];
    }),
  );
  return files.flat().sort();
}

describe("Web Worker E2E provenance", () => {
  it("retains all seven upstream test bodies except the deployment-token hook", async () => {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as ProvenanceManifest;
    const upstreamSnapshot = await readFile(path.join(ROOT, manifest.upstreamSuiteSnapshot.path));
    expect(sha256(upstreamSnapshot)).toBe(manifest.upstreamSuiteSnapshot.sha256);

    const upstreamCases = parseCases(upstreamSnapshot.toString(), manifest.upstreamSuite);
    const localCases = parseCases(
      await readFile(path.join(ROOT, manifest.equivalentSuite), "utf8"),
      manifest.equivalentSuite,
    );
    const expectedNames = manifest.cases.map(({ name }) => name);

    expect(upstreamCases.map(({ name }) => name)).toEqual(expectedNames);
    expect(localCases.map(({ name }) => name)).toEqual(expectedNames);
    expect(upstreamCases.map(({ body }) => findBrowserRoute(body))).toEqual(
      manifest.cases.map(({ route }) => route),
    );
    expect(localCases.map(({ body }) => findBrowserRoute(body))).toEqual(
      manifest.cases.map(({ route }) => route),
    );

    let omissions = 0;
    for (let index = 0; index < upstreamCases.length; index++) {
      const upstream = normalizedBody(upstreamCases[index].body, true);
      const local = normalizedBody(localCases[index].body, false);
      omissions += upstream.omissions;
      expect(local.omissions).toBe(0);
      expect(local.body, expectedNames[index]).toEqual(upstream.body);
    }

    expect(omissions).toBe(7);
    expect(manifest.removed).toEqual([
      "The suite-wide beforePageLoad hook asserting Turbopack's private ?dpl token on every /_next/ request",
    ]);
  });

  it("maps and hashes every checked-in fixture and the upstream config", async () => {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as ProvenanceManifest;
    const fixtureRoot = path.join(ROOT, manifest.fixtureRoot);
    const localFiles = await listFiles(fixtureRoot);

    expect(Object.keys(manifest.sha256).sort()).toEqual(localFiles);
    expect(manifest.byteExactFixturePaths.slice().sort()).toEqual(
      localFiles.filter((file) => file.startsWith("app/") || file.startsWith("public/")),
    );

    for (const [relativePath, expectedHash] of Object.entries(manifest.sha256)) {
      expect(sha256(await readFile(path.join(fixtureRoot, relativePath))), relativePath).toBe(
        expectedHash,
      );
    }

    const configSnapshot = await readFile(path.join(ROOT, manifest.upstreamConfig.path));
    expect(sha256(configSnapshot)).toBe(manifest.upstreamConfig.sha256);
    expect(manifest.upstreamConfig.upstreamPath).toBe(
      `${manifest.upstreamFixtureRoot}/next.config.js`,
    );
    expect(manifest.upstreamConfig.equivalentLocalFiles.slice().sort()).toEqual([
      "package.json",
      "vite.config.mjs",
      "wrangler.jsonc",
    ]);
    expect(manifest.upstreamConfig.equivalence).toContain("Vite/Rolldown");

    const referencedFixtures = new Set([
      ...manifest.commonFixtures,
      ...manifest.cases.flatMap(({ fixtures }) => fixtures),
    ]);
    expect([...referencedFixtures].sort()).toEqual(manifest.byteExactFixturePaths.slice().sort());
  });
});
