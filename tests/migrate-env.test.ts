import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseMigrateEnvArgs,
  classifyVars,
  isVercelSystemVar,
  detectVercelProject,
  detectVercelOrgId,
  detectVercelToken,
  detectVercelCli,
  isVercelCliAuthenticated,
  parseEnvFile,
  fetchVercelEnvVars,
  injectPlainVars,
  writeEnvBackup,
  detectWranglerConfig,
  detectWorkerName,
  stripJsonComments,
  secureDelete,
  uploadSecrets,
  type VercelEnvVar,
} from "../packages/vinext/src/migrate-env.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vinext-migrateenv-test-"));
}

function writeFile(dir: string, relativePath: string, content: string): void {
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function readFile(dir: string, relativePath: string): string {
  return fs.readFileSync(path.join(dir, relativePath), "utf-8");
}

function mkdir(dir: string, relativePath: string): void {
  fs.mkdirSync(path.join(dir, relativePath), { recursive: true });
}

beforeEach(() => {
  tmpDir = createTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── parseMigrateEnvArgs ────────────────────────────────────────────────────

describe("parseMigrateEnvArgs", () => {
  it("defaults with no flags", () => {
    const parsed = parseMigrateEnvArgs([]);
    expect(parsed.help).toBe(false);
    expect(parsed.vercelToken).toBeUndefined();
    expect(parsed.project).toBeUndefined();
    expect(parsed.teamId).toBeUndefined();
    expect(parsed.target).toBeUndefined();
    expect(parsed.dryRun).toBe(false);
    expect(parsed.includeSystem).toBe(false);
    expect(parsed.envFile).toBe(false);
  });

  it("parses --vercel-token", () => {
    const parsed = parseMigrateEnvArgs(["--vercel-token", "tok_abc123"]);
    expect(parsed.vercelToken).toBe("tok_abc123");
  });

  it("parses --project with space-separated value", () => {
    expect(parseMigrateEnvArgs(["--project", "my-app"]).project).toBe("my-app");
  });

  it("parses --project=value form", () => {
    expect(parseMigrateEnvArgs(["--project=my-app"]).project).toBe("my-app");
  });

  it("parses --team", () => {
    expect(parseMigrateEnvArgs(["--team", "team_xxx"]).teamId).toBe("team_xxx");
  });

  it("parses --target production", () => {
    expect(parseMigrateEnvArgs(["--target", "production"]).target).toBe("production");
  });

  it("parses --target preview", () => {
    expect(parseMigrateEnvArgs(["--target", "preview"]).target).toBe("preview");
  });

  it("parses --target development", () => {
    expect(parseMigrateEnvArgs(["--target", "development"]).target).toBe("development");
  });

  it("throws on invalid --target value", () => {
    expect(() => parseMigrateEnvArgs(["--target", "staging"])).toThrow("Invalid --target");
  });

  it("parses boolean flags", () => {
    const parsed = parseMigrateEnvArgs(["--dry-run", "--include-system", "--env-file"]);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.includeSystem).toBe(true);
    expect(parsed.envFile).toBe(true);
  });

  it("parses -h as help", () => {
    expect(parseMigrateEnvArgs(["-h"]).help).toBe(true);
  });

  it("trims whitespace from --vercel-token", () => {
    expect(parseMigrateEnvArgs(["--vercel-token", "  tok_abc  "]).vercelToken).toBe("tok_abc");
  });

  it("treats whitespace-only --project as undefined", () => {
    expect(parseMigrateEnvArgs(["--project", "   "]).project).toBeUndefined();
  });

  it("throws on unknown flags (strict mode)", () => {
    expect(() => parseMigrateEnvArgs(["--bogus"])).toThrow();
  });



  it("parses all flags combined", () => {
    const parsed = parseMigrateEnvArgs([
      "--vercel-token", "tok_abc",
      "--project", "my-app",
      "--team", "team_xxx",
      "--target", "production",
      "--dry-run",
      "--include-system",
      "--env-file",
    ]);
    expect(parsed.vercelToken).toBe("tok_abc");
    expect(parsed.project).toBe("my-app");
    expect(parsed.teamId).toBe("team_xxx");
    expect(parsed.target).toBe("production");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.includeSystem).toBe(true);
    expect(parsed.envFile).toBe(true);
  });
});

// ─── isVercelSystemVar ──────────────────────────────────────────────────────

describe("isVercelSystemVar", () => {
  it("identifies VERCEL_URL as system var", () => {
    expect(isVercelSystemVar("VERCEL_URL")).toBe(true);
  });

  it("identifies VERCEL_ENV as system var", () => {
    expect(isVercelSystemVar("VERCEL_ENV")).toBe(true);
  });

  it("identifies NEXT_PUBLIC_VERCEL_URL as system var", () => {
    expect(isVercelSystemVar("NEXT_PUBLIC_VERCEL_URL")).toBe(true);
  });

  it("does not flag DATABASE_URL as system var", () => {
    expect(isVercelSystemVar("DATABASE_URL")).toBe(false);
  });

  it("does not flag NEXT_PUBLIC_API_KEY as system var", () => {
    expect(isVercelSystemVar("NEXT_PUBLIC_API_KEY")).toBe(false);
  });

  it("does not flag VERCEL_LIKE_VAR without prefix", () => {
    expect(isVercelSystemVar("MY_VERCEL_TOKEN")).toBe(false);
  });

  it("identifies VERCEL exact match as system var", () => {
    expect(isVercelSystemVar("VERCEL")).toBe(true);
  });

  it("identifies CI as system var", () => {
    expect(isVercelSystemVar("CI")).toBe(true);
  });

  it("identifies NX_DAEMON as system var", () => {
    expect(isVercelSystemVar("NX_DAEMON")).toBe(true);
  });

  it("identifies TURBO_CACHE as system var", () => {
    expect(isVercelSystemVar("TURBO_CACHE")).toBe(true);
  });

  it("identifies TURBO_RUN_SUMMARY as system var", () => {
    expect(isVercelSystemVar("TURBO_RUN_SUMMARY")).toBe(true);
  });
});

// ─── classifyVars ───────────────────────────────────────────────────────────

describe("classifyVars", () => {
  const makeVar = (
    key: string,
    value: string,
    type: VercelEnvVar["type"] = "plain",
    target: VercelEnvVar["target"] = ["production"],
    system = false,
  ): VercelEnvVar => ({ key, value, target, type, system });

  it("classifies plain vars as plainVars", () => {
    const vars = [makeVar("API_URL", "https://api.example.com", "plain")];
    const result = classifyVars(vars);
    expect(result.plainVars).toHaveLength(1);
    expect(result.plainVars[0].key).toBe("API_URL");
    expect(result.secrets).toHaveLength(0);
  });

  it("classifies secret vars as secrets", () => {
    const vars = [makeVar("API_KEY", "sk-123", "secret")];
    const result = classifyVars(vars);
    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].key).toBe("API_KEY");
    expect(result.plainVars).toHaveLength(0);
  });

  it("classifies encrypted vars as secrets", () => {
    const vars = [makeVar("DB_PASSWORD", "enc_xxx", "encrypted")];
    const result = classifyVars(vars);
    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].key).toBe("DB_PASSWORD");
  });

  it("classifies sensitive vars as secrets", () => {
    const vars = [makeVar("AUTH_SECRET", "secret_xxx", "sensitive")];
    const result = classifyVars(vars);
    expect(result.secrets).toHaveLength(1);
  });

  it("forces NEXT_PUBLIC_* vars to plain even if marked secret", () => {
    const vars = [makeVar("NEXT_PUBLIC_APP_URL", "https://app.com", "secret")];
    const result = classifyVars(vars);
    expect(result.plainVars).toHaveLength(1);
    expect(result.plainVars[0].key).toBe("NEXT_PUBLIC_APP_URL");
    expect(result.secrets).toHaveLength(0);
  });

  it("skips Vercel system vars by default", () => {
    const vars = [
      makeVar("VERCEL_URL", "my-app.vercel.app", "plain", ["production"], true),
      makeVar("DATABASE_URL", "postgres://...", "secret"),
    ];
    const result = classifyVars(vars);
    expect(result.secrets).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].key).toBe("VERCEL_URL");
    expect(result.skipped[0].reason).toContain("system var");
  });

  it("includes system vars when includeSystem is true", () => {
    const vars = [makeVar("VERCEL_URL", "my-app.vercel.app", "plain", ["production"], true)];
    const result = classifyVars(vars, { includeSystem: true });
    expect(result.plainVars).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it("filters by target when specified", () => {
    const vars = [
      makeVar("API_KEY", "key-prod", "secret", ["production"]),
      makeVar("DEBUG_FLAG", "true", "plain", ["development"]),
    ];
    const result = classifyVars(vars, { target: "production" });
    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].key).toBe("API_KEY");
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].key).toBe("DEBUG_FLAG");
  });

  it("includes vars with matching target", () => {
    const vars = [
      makeVar("API_KEY", "key-all", "secret", ["production", "preview", "development"]),
    ];
    const result = classifyVars(vars, { target: "preview" });
    expect(result.secrets).toHaveLength(1);
  });

  it("includes vars with empty target (applies to all)", () => {
    const vars = [makeVar("GLOBAL_VAR", "value", "plain", [])];
    const result = classifyVars(vars, { target: "production" });
    expect(result.plainVars).toHaveLength(1);
  });

  it("handles duplicate keys (last wins)", () => {
    const vars = [
      makeVar("API_KEY", "old-value", "secret", ["production"]),
      makeVar("API_KEY", "new-value", "secret", ["production"]),
    ];
    const result = classifyVars(vars);
    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].value).toBe("new-value");
    // Should have a skipped entry noting the duplicate
    expect(result.skipped.some((s) => s.key.includes("duplicate"))).toBe(true);
  });

  it("handles empty var list", () => {
    const result = classifyVars([]);
    expect(result.secrets).toHaveLength(0);
    expect(result.plainVars).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("handles vars with empty values", () => {
    const vars = [makeVar("EMPTY_VAR", "", "plain")];
    const result = classifyVars(vars);
    expect(result.plainVars).toHaveLength(1);
    expect(result.plainVars[0].value).toBe("");
  });

  it("classifies system vars by prefix even without system flag", () => {
    const vars = [makeVar("VERCEL_ENV", "production", "plain", ["production"], false)];
    const result = classifyVars(vars);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("system var");
  });

  it("classifies mixed batch correctly", () => {
    const vars = [
      makeVar("DATABASE_URL", "postgres://...", "secret"),
      makeVar("API_URL", "https://api.com", "plain"),
      makeVar("NEXT_PUBLIC_APP_NAME", "My App", "secret"),
      makeVar("VERCEL_URL", "app.vercel.app", "plain", ["production"], true),
      makeVar("AUTH_TOKEN", "tok_xxx", "encrypted"),
    ];
    const result = classifyVars(vars);
    expect(result.secrets).toHaveLength(2); // DATABASE_URL, AUTH_TOKEN
    expect(result.plainVars).toHaveLength(2); // API_URL, NEXT_PUBLIC_APP_NAME
    expect(result.skipped).toHaveLength(1); // VERCEL_URL
  });
});

// ─── detectVercelProject ────────────────────────────────────────────────────

describe("detectVercelProject", () => {
  it("reads project ID from .vercel/project.json", () => {
    writeFile(tmpDir, ".vercel/project.json", JSON.stringify({
      projectId: "prj_abc123",
      orgId: "org_xxx",
    }));
    expect(detectVercelProject(tmpDir)).toBe("prj_abc123");
  });

  it("falls back to package.json name", () => {
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "my-app" }));
    expect(detectVercelProject(tmpDir)).toBe("my-app");
  });

  it("strips npm scope from package.json name", () => {
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "@org/my-app" }));
    expect(detectVercelProject(tmpDir)).toBe("my-app");
  });

  it("prefers .vercel/project.json over package.json", () => {
    writeFile(tmpDir, ".vercel/project.json", JSON.stringify({ projectId: "prj_abc" }));
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "pkg-name" }));
    expect(detectVercelProject(tmpDir)).toBe("prj_abc");
  });

  it("returns null when no project info available", () => {
    expect(detectVercelProject(tmpDir)).toBeNull();
  });

  it("handles malformed .vercel/project.json gracefully", () => {
    writeFile(tmpDir, ".vercel/project.json", "not json");
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "fallback-app" }));
    expect(detectVercelProject(tmpDir)).toBe("fallback-app");
  });

  it("handles .vercel/project.json without projectId", () => {
    writeFile(tmpDir, ".vercel/project.json", JSON.stringify({ orgId: "org_xxx" }));
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "fallback-app" }));
    expect(detectVercelProject(tmpDir)).toBe("fallback-app");
  });
});

// ─── detectVercelOrgId ──────────────────────────────────────────────────────

describe("detectVercelOrgId", () => {
  it("reads orgId from .vercel/project.json", () => {
    writeFile(tmpDir, ".vercel/project.json", JSON.stringify({
      projectId: "prj_abc123",
      orgId: "team_xyz789",
    }));
    expect(detectVercelOrgId(tmpDir)).toBe("team_xyz789");
  });

  it("returns null when no .vercel/project.json exists", () => {
    expect(detectVercelOrgId(tmpDir)).toBeNull();
  });

  it("returns null when orgId is missing", () => {
    writeFile(tmpDir, ".vercel/project.json", JSON.stringify({ projectId: "prj_abc" }));
    expect(detectVercelOrgId(tmpDir)).toBeNull();
  });

  it("handles malformed JSON gracefully", () => {
    writeFile(tmpDir, ".vercel/project.json", "not valid json");
    expect(detectVercelOrgId(tmpDir)).toBeNull();
  });
});

// ─── detectVercelToken ──────────────────────────────────────────────────────

describe("detectVercelToken", () => {
  it("doesn't crash when no auth files exist", () => {
    const result = detectVercelToken();
    expect(result === null || typeof result === "string").toBe(true);
  });
});

// ─── detectVercelCli ────────────────────────────────────────────────────────

describe("detectVercelCli", () => {
  it("returns string or null without crashing", () => {
    const result = detectVercelCli();
    expect(result === null || typeof result === "string").toBe(true);
  });
});

// ─── isVercelCliAuthenticated ───────────────────────────────────────────────

describe("isVercelCliAuthenticated", () => {
  it("returns boolean without crashing", () => {
    const result = isVercelCliAuthenticated();
    expect(typeof result).toBe("boolean");
  });
});

// ─── parseEnvFile ───────────────────────────────────────────────────────────

describe("parseEnvFile", () => {
  it("parses simple KEY=VALUE pairs", () => {
    const content = "API_KEY=abc123\nDB_URL=postgres://localhost";
    const result = parseEnvFile(content);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: "API_KEY", value: "abc123" });
    expect(result[1]).toEqual({ key: "DB_URL", value: "postgres://localhost" });
  });

  it("skips comments and empty lines", () => {
    const content = "# This is a comment\n\nAPI_KEY=abc123\n# Another comment";
    const result = parseEnvFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("API_KEY");
  });

  it("handles double-quoted values", () => {
    const content = 'GREETING="hello world"';
    const result = parseEnvFile(content);
    expect(result[0].value).toBe("hello world");
  });

  it("handles single-quoted values", () => {
    const content = "GREETING='hello world'";
    const result = parseEnvFile(content);
    expect(result[0].value).toBe("hello world");
  });

  it("unescapes \\n in double-quoted values", () => {
    const content = 'MULTILINE="line1\\nline2"';
    const result = parseEnvFile(content);
    expect(result[0].value).toBe("line1\nline2");
  });

  it("does not unescape in single-quoted values", () => {
    const content = "RAW='hello\\nworld'";
    const result = parseEnvFile(content);
    expect(result[0].value).toBe("hello\\nworld");
  });

  it("handles values with equals signs", () => {
    const content = "CONNECTION=host=localhost;port=5432";
    const result = parseEnvFile(content);
    expect(result[0].value).toBe("host=localhost;port=5432");
  });

  it("handles empty values", () => {
    const content = "EMPTY_VAR=";
    const result = parseEnvFile(content);
    expect(result[0]).toEqual({ key: "EMPTY_VAR", value: "" });
  });

  it("skips lines without equals sign", () => {
    const content = "NO_EQUALS_HERE\nVALID=yes";
    const result = parseEnvFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("VALID");
  });

  it("handles empty input", () => {
    expect(parseEnvFile("")).toHaveLength(0);
  });

  it("handles Vercel env pull header comments", () => {
    const content = `# Created by Vercel CLI\nNEXT_PUBLIC_APP="my app"\nDB_URL=postgres://...`;
    const result = parseEnvFile(content);
    expect(result).toHaveLength(2);
  });

  it("handles escaped quotes in double-quoted values", () => {
    const content = 'MSG="say \\"hello\\""';
    const result = parseEnvFile(content);
    expect(result[0].value).toBe('say "hello"');
  });
});

// ─── fetchVercelEnvVars ─────────────────────────────────────────────────────

describe("fetchVercelEnvVars", () => {
  function mockFetcher(responses: Array<{ status: number; body: unknown }>): typeof fetch {
    let callIndex = 0;
    return async (input: RequestInfo | URL) => {
      const response = responses[callIndex++] ?? responses[responses.length - 1];
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    };
  }

  it("fetches env vars from Vercel API", async () => {
    const fetcher = mockFetcher([{
      status: 200,
      body: {
        envs: [
          { key: "DB_URL", value: "postgres://...", target: ["production"], type: "secret" },
          { key: "API_URL", value: "https://api.com", target: ["production"], type: "plain" },
        ],
      },
    }]);

    const vars = await fetchVercelEnvVars("tok_test", "my-project", undefined, fetcher);
    expect(vars).toHaveLength(2);
    expect(vars[0].key).toBe("DB_URL");
    expect(vars[1].key).toBe("API_URL");
  });

  it("throws on 401 unauthorized", async () => {
    const fetcher = mockFetcher([{ status: 401, body: { error: "Unauthorized" } }]);
    await expect(fetchVercelEnvVars("bad_token", "proj", undefined, fetcher))
      .rejects.toThrow("authentication failed");
  });

  it("throws on 403 forbidden", async () => {
    const fetcher = mockFetcher([{ status: 403, body: { error: "Forbidden" } }]);
    await expect(fetchVercelEnvVars("tok", "proj", undefined, fetcher))
      .rejects.toThrow("access denied");
  });

  it("throws on 404 not found", async () => {
    const fetcher = mockFetcher([{ status: 404, body: { error: "Not found" } }]);
    await expect(fetchVercelEnvVars("tok", "proj", undefined, fetcher))
      .rejects.toThrow("not found");
  });

  it("handles pagination", async () => {
    // First page: 100 items (triggers next page)
    const page1Envs = Array.from({ length: 100 }, (_, i) => ({
      key: `VAR_${i}`,
      value: `val_${i}`,
      target: ["production"],
      type: "plain" as const,
    }));
    // Second page: 5 items (less than 100, stops pagination)
    const page2Envs = Array.from({ length: 5 }, (_, i) => ({
      key: `VAR_${100 + i}`,
      value: `val_${100 + i}`,
      target: ["production"],
      type: "plain" as const,
    }));

    const fetcher = mockFetcher([
      { status: 200, body: { envs: page1Envs } },
      { status: 200, body: { envs: page2Envs } },
    ]);

    const vars = await fetchVercelEnvVars("tok", "proj", undefined, fetcher);
    expect(vars).toHaveLength(105);
  });

  it("handles empty env list", async () => {
    const fetcher = mockFetcher([{ status: 200, body: { envs: [] } }]);
    const vars = await fetchVercelEnvVars("tok", "proj", undefined, fetcher);
    expect(vars).toHaveLength(0);
  });

  it("handles vars with missing value (defaults to empty string)", async () => {
    const fetcher = mockFetcher([{
      status: 200,
      body: {
        envs: [{ key: "EMPTY", target: ["production"], type: "plain" }],
      },
    }]);
    const vars = await fetchVercelEnvVars("tok", "proj", undefined, fetcher);
    expect(vars[0].value).toBe("");
  });

  it("passes teamId as query parameter", async () => {
    let capturedUrl = "";
    const fetcher: typeof fetch = async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ envs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await fetchVercelEnvVars("tok", "proj", "team_xxx", fetcher);
    expect(capturedUrl).toContain("teamId=team_xxx");
  });
});

// ─── stripJsonComments ──────────────────────────────────────────────────────

describe("stripJsonComments", () => {
  it("strips single-line comments", () => {
    const input = `{
  // this is a comment
  "name": "test"
}`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ name: "test" });
  });

  it("strips multi-line comments", () => {
    const input = `{
  /* multi
   * line
   * comment */
  "name": "test"
}`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ name: "test" });
  });

  it("preserves URLs in string values", () => {
    const input = `{ "url": "https://example.com" }`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ url: "https://example.com" });
  });

  it("preserves // inside strings", () => {
    const input = `{ "path": "foo//bar" }`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ path: "foo//bar" });
  });

  it("handles escaped quotes in strings", () => {
    const input = `{ "value": "he said \\"hello\\"" }`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ value: 'he said "hello"' });
  });

  it("handles empty input", () => {
    expect(stripJsonComments("")).toBe("");
  });
});

// ─── detectWranglerConfig ───────────────────────────────────────────────────

describe("detectWranglerConfig", () => {
  it("detects wrangler.jsonc", () => {
    writeFile(tmpDir, "wrangler.jsonc", "{}");
    const config = detectWranglerConfig(tmpDir);
    expect(config?.format).toBe("json");
    expect(config?.path).toContain("wrangler.jsonc");
  });

  it("detects wrangler.json", () => {
    writeFile(tmpDir, "wrangler.json", "{}");
    const config = detectWranglerConfig(tmpDir);
    expect(config?.format).toBe("json");
  });

  it("detects wrangler.toml", () => {
    writeFile(tmpDir, "wrangler.toml", "[vars]");
    const config = detectWranglerConfig(tmpDir);
    expect(config?.format).toBe("toml");
  });

  it("returns null when no config exists", () => {
    expect(detectWranglerConfig(tmpDir)).toBeNull();
  });

  it("prefers jsonc over json over toml", () => {
    writeFile(tmpDir, "wrangler.jsonc", "{}");
    writeFile(tmpDir, "wrangler.json", "{}");
    writeFile(tmpDir, "wrangler.toml", "[vars]");
    const config = detectWranglerConfig(tmpDir);
    expect(config?.path).toContain("wrangler.jsonc");
  });
});

// ─── detectWorkerName ───────────────────────────────────────────────────────

describe("detectWorkerName", () => {
  it("reads name from wrangler.jsonc", () => {
    writeFile(tmpDir, "wrangler.jsonc", JSON.stringify({ name: "my-worker" }));
    expect(detectWorkerName(tmpDir)).toBe("my-worker");
  });

  it("reads name from wrangler.jsonc with comments", () => {
    writeFile(tmpDir, "wrangler.jsonc", `{
  // Worker name
  "name": "commented-worker"
}`);
    expect(detectWorkerName(tmpDir)).toBe("commented-worker");
  });

  it("returns null when no wrangler config", () => {
    expect(detectWorkerName(tmpDir)).toBeNull();
  });

  it("returns null for toml config", () => {
    writeFile(tmpDir, "wrangler.toml", 'name = "my-worker"');
    expect(detectWorkerName(tmpDir)).toBeNull();
  });

  it("returns null when name field missing", () => {
    writeFile(tmpDir, "wrangler.jsonc", JSON.stringify({ compatibility_date: "2026-01-01" }));
    expect(detectWorkerName(tmpDir)).toBeNull();
  });
});

// ─── injectPlainVars ────────────────────────────────────────────────────────

describe("injectPlainVars", () => {
  it("throws when no wrangler config exists", () => {
    expect(() =>
      injectPlainVars(tmpDir, [{ key: "API_URL", value: "https://api.com" }])
    ).toThrow("No wrangler config found");
  });

  it("merges into existing wrangler.jsonc vars", () => {
    writeFile(tmpDir, "wrangler.jsonc", JSON.stringify({
      name: "my-worker",
      vars: { EXISTING: "value" },
    }));

    const result = injectPlainVars(tmpDir, [{ key: "NEW_VAR", value: "new" }]);
    expect(result.added).toBe(1);

    const config = JSON.parse(readFile(tmpDir, "wrangler.jsonc"));
    expect(config.vars.EXISTING).toBe("value");
    expect(config.vars.NEW_VAR).toBe("new");
    expect(config.name).toBe("my-worker"); // preserves other fields
  });

  it("creates vars section when missing in existing config", () => {
    writeFile(tmpDir, "wrangler.jsonc", JSON.stringify({ name: "my-worker" }));

    injectPlainVars(tmpDir, [{ key: "API_KEY", value: "abc" }]);

    const config = JSON.parse(readFile(tmpDir, "wrangler.jsonc"));
    expect(config.vars.API_KEY).toBe("abc");
  });

  it("reports conflicts when overwriting existing vars", () => {
    writeFile(tmpDir, "wrangler.jsonc", JSON.stringify({
      vars: { API_URL: "old-value" },
    }));

    const result = injectPlainVars(tmpDir, [{ key: "API_URL", value: "new-value" }]);
    expect(result.conflicts).toContain("API_URL");
    expect(result.warnings.some((w) => w.includes("overwritten"))).toBe(true);

    const config = JSON.parse(readFile(tmpDir, "wrangler.jsonc"));
    expect(config.vars.API_URL).toBe("new-value");
  });

  it("does not report conflict when value is the same", () => {
    writeFile(tmpDir, "wrangler.jsonc", JSON.stringify({
      vars: { API_URL: "same-value" },
    }));

    const result = injectPlainVars(tmpDir, [{ key: "API_URL", value: "same-value" }]);
    expect(result.conflicts).toHaveLength(0);
  });

  it("warns for toml config", () => {
    writeFile(tmpDir, "wrangler.toml", "[vars]\nAPI_URL = \"old\"");

    const result = injectPlainVars(tmpDir, [{ key: "NEW", value: "val" }]);
    expect(result.added).toBe(0);
    expect(result.warnings.some((w) => w.includes("TOML") || w.includes("toml"))).toBe(true);
  });

  it("returns empty result for empty vars list", () => {
    const result = injectPlainVars(tmpDir, []);
    expect(result.added).toBe(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("handles dry run without writing", () => {
    const result = injectPlainVars(tmpDir, [{ key: "API_URL", value: "val" }], true);
    expect(result.added).toBe(1);
    // Should not have created the file
    expect(result.warnings.some((w) => w.includes("dry-run") || w.includes("Would"))).toBe(true);
  });

  it("handles multiple vars at once", () => {
    writeFile(tmpDir, "wrangler.jsonc", JSON.stringify({ name: "worker" }));

    const vars = [
      { key: "VAR_A", value: "a" },
      { key: "VAR_B", value: "b" },
      { key: "VAR_C", value: "c" },
    ];
    const result = injectPlainVars(tmpDir, vars);
    expect(result.added).toBe(3);

    const config = JSON.parse(readFile(tmpDir, "wrangler.jsonc"));
    expect(config.vars.VAR_A).toBe("a");
    expect(config.vars.VAR_B).toBe("b");
    expect(config.vars.VAR_C).toBe("c");
  });

  it("handles JSONC with comments", () => {
    // Note: after parsing + re-serializing, comments will be lost (expected behavior)
    writeFile(tmpDir, "wrangler.jsonc", `{
  // Worker config
  "name": "my-worker",
  "vars": {
    "EXISTING": "value"
  }
}`);

    const result = injectPlainVars(tmpDir, [{ key: "NEW", value: "val" }]);
    expect(result.added).toBe(1);

    const config = JSON.parse(readFile(tmpDir, "wrangler.jsonc"));
    expect(config.vars.EXISTING).toBe("value");
    expect(config.vars.NEW).toBe("val");
  });
});

// ─── writeEnvBackup ─────────────────────────────────────────────────────────

describe("writeEnvBackup", () => {
  it("writes .env.cloudflare file", () => {
    const vars = [
      { key: "API_KEY", value: "abc123" },
      { key: "DB_URL", value: "postgres://localhost/db" },
    ];
    writeEnvBackup(tmpDir, vars);

    const content = readFile(tmpDir, ".env.cloudflare");
    expect(content).toContain("API_KEY=abc123");
    expect(content).toContain("DB_URL=postgres://localhost/db");
    expect(content).toContain("Auto-generated by vinext migrateenv");
  });

  it("quotes values with special characters", () => {
    const vars = [
      { key: "MULTI", value: "line1\nline2" },
      { key: "WITH_EQUALS", value: "foo=bar" },
      { key: "WITH_SPACES", value: "hello world" },
      { key: "WITH_DOLLAR", value: "price$100" },
    ];
    writeEnvBackup(tmpDir, vars);

    const content = readFile(tmpDir, ".env.cloudflare");
    expect(content).toContain('MULTI="line1\\nline2"');
    expect(content).toContain('WITH_EQUALS="foo=bar"');
    expect(content).toContain('WITH_SPACES="hello world"');
    expect(content).toContain('WITH_DOLLAR="price$100"');
  });

  it("handles empty values", () => {
    const vars = [{ key: "EMPTY", value: "" }];
    writeEnvBackup(tmpDir, vars);

    const content = readFile(tmpDir, ".env.cloudflare");
    expect(content).toContain("EMPTY=");
  });

  it("adds .env.cloudflare to .gitignore", () => {
    writeFile(tmpDir, ".gitignore", "node_modules\n");

    writeEnvBackup(tmpDir, [{ key: "FOO", value: "bar" }]);

    const gitignore = readFile(tmpDir, ".gitignore");
    expect(gitignore).toContain(".env.cloudflare");
  });

  it("does not duplicate .env.cloudflare in .gitignore", () => {
    writeFile(tmpDir, ".gitignore", "node_modules\n.env.cloudflare\n");

    writeEnvBackup(tmpDir, [{ key: "FOO", value: "bar" }]);

    const gitignore = readFile(tmpDir, ".gitignore");
    const count = gitignore.split(".env.cloudflare").length - 1;
    expect(count).toBe(1);
  });

  it("does nothing for empty vars list", () => {
    writeEnvBackup(tmpDir, []);
    expect(fs.existsSync(path.join(tmpDir, ".env.cloudflare"))).toBe(false);
  });

  it("does not write in dry run mode", () => {
    writeEnvBackup(tmpDir, [{ key: "FOO", value: "bar" }], true);
    expect(fs.existsSync(path.join(tmpDir, ".env.cloudflare"))).toBe(false);
  });
});

// ─── secureDelete ───────────────────────────────────────────────────────────

describe("secureDelete", () => {
  it("deletes a file", () => {
    const filePath = path.join(tmpDir, "secret.json");
    fs.writeFileSync(filePath, "sensitive data");
    expect(fs.existsSync(filePath)).toBe(true);

    secureDelete(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("handles non-existent file gracefully", () => {
    const filePath = path.join(tmpDir, "nonexistent.json");
    expect(() => secureDelete(filePath)).not.toThrow();
  });
});

// ─── uploadSecrets ──────────────────────────────────────────────────────────

describe("uploadSecrets", () => {
  it("returns empty result for no secrets", () => {
    const result = uploadSecrets(tmpDir, []);
    expect(result.uploaded).toBe(0);
    expect(result.output).toContain("No secrets");
  });

  it("returns dry-run output without uploading", () => {
    const secrets = [
      { key: "API_KEY", value: "abc" },
      { key: "DB_PASS", value: "xyz" },
    ];
    const result = uploadSecrets(tmpDir, secrets, "my-worker", true);
    expect(result.uploaded).toBe(0);
    expect(result.output).toContain("dry-run");
    expect(result.output).toContain("API_KEY");
    expect(result.output).toContain("DB_PASS");
    expect(result.output).toContain("2 secret(s)");
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles multiline env var values in classification", () => {
    const vars: VercelEnvVar[] = [{
      key: "PRIVATE_KEY",
      value: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpA...\n-----END RSA PRIVATE KEY-----",
      target: ["production"],
      type: "secret",
    }];
    const result = classifyVars(vars);
    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].value).toContain("\n");
  });

  it("handles values with special characters", () => {
    const vars: VercelEnvVar[] = [{
      key: "SPECIAL",
      value: 'value with "quotes" and $dollars and `backticks`',
      target: ["production"],
      type: "plain",
    }];
    const result = classifyVars(vars);
    expect(result.plainVars).toHaveLength(1);
    expect(result.plainVars[0].value).toContain('"quotes"');
  });

  it("handles very long env var values", () => {
    const longValue = "x".repeat(10000);
    const vars: VercelEnvVar[] = [{
      key: "LONG_VAR",
      value: longValue,
      target: ["production"],
      type: "plain",
    }];
    const result = classifyVars(vars);
    expect(result.plainVars).toHaveLength(1);
    expect(result.plainVars[0].value.length).toBe(10000);
  });

  it("writeEnvBackup handles values with quotes correctly", () => {
    const vars = [{ key: "QUOTED", value: 'value "with" quotes' }];
    writeEnvBackup(tmpDir, vars);

    const content = readFile(tmpDir, ".env.cloudflare");
    expect(content).toContain('QUOTED="value \\"with\\" quotes"');
  });

  it("writeEnvBackup handles values with backslashes", () => {
    const vars = [{ key: "ESCAPED", value: "path\\to\\file" }];
    writeEnvBackup(tmpDir, vars);

    const content = readFile(tmpDir, ".env.cloudflare");
    // Should be properly escaped
    expect(content).toContain("ESCAPED=path\\to\\file");
  });
});
