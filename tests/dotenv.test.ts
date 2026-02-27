import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadDotenv,
  getDotenvFiles,
} from "../packages/vinext/src/config/dotenv.js";

let tmpDir: string;

function writeFile(relativePath: string, content: string): void {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-dotenv-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getDotenvFiles", () => {
  it("returns correct file list for development", () => {
    expect(getDotenvFiles("development")).toEqual([
      ".env.development.local",
      ".env.local",
      ".env.development",
      ".env",
    ]);
  });

  it("returns correct file list for production", () => {
    expect(getDotenvFiles("production")).toEqual([
      ".env.production.local",
      ".env.local",
      ".env.production",
      ".env",
    ]);
  });

  it("skips .env.local for test mode", () => {
    const files = getDotenvFiles("test");
    expect(files).toEqual([
      ".env.test.local",
      ".env.test",
      ".env",
    ]);
    expect(files).not.toContain(".env.local");
  });
});

describe("loadDotenv", () => {
  it("applies Next.js precedence for development mode", () => {
    writeFile(".env", "ORDER=env\nSECOND=env\n");
    writeFile(".env.development", "ORDER=mode\nSECOND=mode\n");
    writeFile(".env.local", "ORDER=local\nSECOND=local\n");
    writeFile(".env.development.local", "ORDER=mode-local\n");

    const env: NodeJS.ProcessEnv = {
      ORDER: "process",
      FROM_PROCESS: "yes",
    };

    const result = loadDotenv({
      root: tmpDir,
      mode: "development",
      processEnv: env,
    });

    // process.env values always win
    expect(env.ORDER).toBe("process");
    // .env.local beats .env.development and .env
    expect(env.SECOND).toBe("local");
    // pre-existing values are untouched
    expect(env.FROM_PROCESS).toBe("yes");

    // loadedEnv only contains keys actually written (not pre-existing)
    expect(result.loadedEnv).not.toHaveProperty("ORDER");
    expect(result.loadedEnv.SECOND).toBe("local");

    // all existing files are reported as loaded
    expect(result.loadedFiles).toEqual([
      ".env.development.local",
      ".env.local",
      ".env.development",
      ".env",
    ]);
  });

  it("applies Next.js precedence for production mode", () => {
    writeFile(".env", "DB_HOST=from-env\nAPI_KEY=from-env\n");
    writeFile(".env.production", "DB_HOST=from-prod\n");
    writeFile(".env.local", "DB_HOST=from-local\nAPI_KEY=from-local\n");
    writeFile(".env.production.local", "DB_HOST=from-prod-local\n");

    const env: NodeJS.ProcessEnv = {};

    const result = loadDotenv({
      root: tmpDir,
      mode: "production",
      processEnv: env,
    });

    // .env.production.local has highest file priority
    expect(env.DB_HOST).toBe("from-prod-local");
    // .env.local beats .env.production and .env
    expect(env.API_KEY).toBe("from-local");

    expect(result.loadedEnv.DB_HOST).toBe("from-prod-local");
    expect(result.loadedEnv.API_KEY).toBe("from-local");
    expect(result.loadedFiles).toEqual([
      ".env.production.local",
      ".env.local",
      ".env.production",
      ".env",
    ]);
  });

  it("skips .env.local in test mode", () => {
    writeFile(".env.local", "TEST_VALUE=from-local\n");
    writeFile(".env.test", "TEST_VALUE=from-test\n");
    writeFile(".env", "TEST_VALUE=from-env\n");

    const env: NodeJS.ProcessEnv = {};
    const result = loadDotenv({
      root: tmpDir,
      mode: "test",
      processEnv: env,
    });

    expect(env.TEST_VALUE).toBe("from-test");
    expect(result.loadedFiles).not.toContain(".env.local");
    expect(result.loadedFiles).toContain(".env.test");
    expect(result.loadedEnv.TEST_VALUE).toBe("from-test");
  });

  it("expands variables using $VAR syntax", () => {
    writeFile(
      ".env",
      "BASE_URL=https://example.com\nAPI_URL=$BASE_URL/v1\n",
    );

    const env: NodeJS.ProcessEnv = {};
    const result = loadDotenv({
      root: tmpDir,
      mode: "development",
      processEnv: env,
    });

    expect(env.API_URL).toBe("https://example.com/v1");
    expect(result.loadedEnv.API_URL).toBe("https://example.com/v1");
  });

  it("expands variables using ${VAR} syntax", () => {
    writeFile(
      ".env",
      "HOST=localhost\nPORT=3000\nURL=http://${HOST}:${PORT}\n",
    );

    const env: NodeJS.ProcessEnv = {};
    loadDotenv({ root: tmpDir, mode: "development", processEnv: env });

    expect(env.URL).toBe("http://localhost:3000");
  });

  it("expansion prefers process.env over file values", () => {
    writeFile(
      ".env.development.local",
      "BASE_URL=https://from-file.example.com\nAPI_URL=$BASE_URL/v1\n",
    );

    const env: NodeJS.ProcessEnv = {
      BASE_URL: "https://from-process.example.com",
    };

    loadDotenv({
      root: tmpDir,
      mode: "development",
      processEnv: env,
    });

    // BASE_URL from process.env wins, and expansion uses it
    expect(env.BASE_URL).toBe("https://from-process.example.com");
    expect(env.API_URL).toBe("https://from-process.example.com/v1");
  });

  it("handles escaped dollar signs", () => {
    writeFile(".env", "PRICE=\\$100\n");

    const env: NodeJS.ProcessEnv = {};
    loadDotenv({ root: tmpDir, mode: "development", processEnv: env });

    expect(env.PRICE).toBe("$100");
  });

  it("handles circular variable references without infinite loop", () => {
    writeFile(".env", "A=$B\nB=$A\n");

    const env: NodeJS.ProcessEnv = {};
    // Should not hang — cycle detection breaks the loop
    loadDotenv({ root: tmpDir, mode: "development", processEnv: env });

    // Both resolve to empty string (cycle with no base value)
    expect(env.A).toBeDefined();
    expect(env.B).toBeDefined();
  });

  it("skips missing files without error", () => {
    // Only .env exists, others are missing
    writeFile(".env", "ONLY=here\n");

    const env: NodeJS.ProcessEnv = {};
    const result = loadDotenv({
      root: tmpDir,
      mode: "development",
      processEnv: env,
    });

    expect(env.ONLY).toBe("here");
    expect(result.loadedFiles).toEqual([".env"]);
  });

  it("expands variables across files (lower-priority file references higher-priority)", () => {
    // DB_HOST is defined in .env.development.local (highest file priority)
    // DB_URL in .env references it — should resolve via processEnv accumulation
    writeFile(".env.development.local", "DB_HOST=localhost\n");
    writeFile(".env", "DB_URL=postgres://$DB_HOST/mydb\n");

    const env: NodeJS.ProcessEnv = {};
    loadDotenv({ root: tmpDir, mode: "development", processEnv: env });

    expect(env.DB_HOST).toBe("localhost");
    expect(env.DB_URL).toBe("postgres://localhost/mydb");
  });

  it("handles multi-line quoted values", () => {
    writeFile(
      ".env",
      'MULTI="line1\nline2\nline3"\nSINGLE=plain\n',
    );

    const env: NodeJS.ProcessEnv = {};
    loadDotenv({ root: tmpDir, mode: "development", processEnv: env });

    expect(env.MULTI).toBe("line1\nline2\nline3");
    expect(env.SINGLE).toBe("plain");
  });

  it("returns empty result when no .env files exist", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadDotenv({
      root: tmpDir,
      mode: "development",
      processEnv: env,
    });

    expect(result.loadedFiles).toEqual([]);
    expect(result.loadedEnv).toEqual({});
  });
});
