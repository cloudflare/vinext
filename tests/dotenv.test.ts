import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDotenv } from "../packages/vinext/src/config/dotenv.js";

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

    loadDotenv({
      root: tmpDir,
      mode: "development",
      processEnv: env,
    });

    expect(env.ORDER).toBe("process");
    expect(env.SECOND).toBe("local");
    expect(env.FROM_PROCESS).toBe("yes");
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
  });

  it("expands variables and respects existing process env values", () => {
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

    expect(env.BASE_URL).toBe("https://from-process.example.com");
    expect(env.API_URL).toBe("https://from-process.example.com/v1");
  });
});
