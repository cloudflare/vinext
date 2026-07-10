import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getDb = vi.fn();
const getGitHubToken = vi.fn();

vi.mock("../apps/web/app/lib/db/client", () => ({ getDb, getGitHubToken }));

const { POST, compareDeploySuiteReports } =
  await import("../apps/web/app/api/compatibility/compare/route");

type Report = Parameters<typeof compareDeploySuiteReports>[0];

const baselineReport: Report = {
  timestamp: "2026-06-28T00:00:00.000Z",
  vinextRef: "main",
  nextRef: "v16.2.6",
  suiteFilter: "all",
  summary: { total: 4, passed: 2, failed: 2, skipped: 0 },
  passed: [
    { suite: "test/e2e/app-dir/a/a.test.ts", test: "a passes" },
    { suite: "test/e2e/app-dir/shared/shared.test.ts", test: "shared stays passing" },
  ],
  failed: [
    { suite: "test/e2e/app-dir/b/b.test.ts", test: "b fails" },
    { suite: "test/e2e/app-dir/c/c.test.ts", test: "c fails" },
  ],
};

const targetReport: Report = {
  timestamp: "2026-06-29T00:00:00.000Z",
  vinextRef: "feature",
  nextRef: "v16.2.6",
  suiteFilter: "all",
  summary: { total: 5, passed: 3, failed: 2, skipped: 0 },
  passed: [
    { suite: "test/e2e/app-dir/b/b.test.ts", test: "b fails" },
    { suite: "test/e2e/app-dir/d/d.test.ts", test: "d passes" },
    { suite: "test/e2e/app-dir/shared/shared.test.ts", test: "shared stays passing" },
  ],
  failed: [
    { suite: "test/e2e/app-dir/a/a.test.ts", test: "a passes" },
    { suite: "test/e2e/app-dir/e/e.test.ts", test: "e newly fails" },
  ],
};

describe("deploy-suite report comparison", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    getDb.mockReset();
    getGitHubToken.mockReset();
    getGitHubToken.mockReturnValue("github-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("groups pass/fail changes between two deploy-suite reports", () => {
    expect(compareDeploySuiteReports(baselineReport, targetReport)).toEqual({
      regressions: [
        {
          suite: "test/e2e/app-dir/a/a.test.ts",
          test: "a passes",
          before: "passed",
          after: "failed",
        },
      ],
      newFailures: [
        {
          suite: "test/e2e/app-dir/e/e.test.ts",
          test: "e newly fails",
          before: "missing",
          after: "failed",
        },
      ],
      fixes: [
        {
          suite: "test/e2e/app-dir/b/b.test.ts",
          test: "b fails",
          before: "failed",
          after: "passed",
        },
      ],
      noLongerFailing: [
        {
          suite: "test/e2e/app-dir/c/c.test.ts",
          test: "c fails",
          before: "failed",
          after: "missing",
        },
      ],
    });
  });

  it("defaults the baseline to the latest ingested main run and downloads both report artifacts", async () => {
    getDb.mockReturnValue(createDb([{ runKey: "111" }]));
    const requests: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, authorization: readAuthorization(init?.headers) });
      if (url.includes("/runs/111/artifacts")) {
        return Response.json({
          artifacts: [
            {
              name: "deploy-suite-report",
              expired: false,
              archive_download_url: "https://artifacts.example/baseline.zip",
            },
          ],
        });
      }
      if (url.includes("/runs/222/artifacts")) {
        return Response.json({
          artifacts: [
            {
              name: "deploy-suite-report",
              expired: false,
              archive_download_url: "https://artifacts.example/target.zip",
            },
          ],
        });
      }
      if (url === "https://artifacts.example/baseline.zip") {
        return new Response(zipReport(baselineReport));
      }
      if (url === "https://artifacts.example/target.zip") {
        return new Response(zipReport(targetReport));
      }
      return new Response("not found", { status: 404 });
    });

    const response = await POST(
      new Request("https://example.com/api/compatibility/compare", {
        method: "POST",
        body: JSON.stringify({ targetRunId: "222" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      baseline: {
        runId: "111",
        report: { summary: baselineReport.summary },
      },
      target: {
        runId: "222",
        report: { summary: targetReport.summary },
      },
      delta: { total: 1, passed: 1, failed: 0, skipped: 0 },
      totals: {
        regressions: 1,
        newFailures: 1,
        fixes: 1,
        noLongerFailing: 1,
      },
    });
    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/cloudflare/vinext/actions/runs/111/artifacts?per_page=100",
        authorization: null,
      },
      {
        url: "https://api.github.com/repos/cloudflare/vinext/actions/runs/222/artifacts?per_page=100",
        authorization: null,
      },
      { url: "https://artifacts.example/baseline.zip", authorization: "Bearer github-token" },
      { url: "https://artifacts.example/target.zip", authorization: "Bearer github-token" },
    ]);
  });

  it("rejects missing comparison run ids", async () => {
    const response = await POST(
      new Request("https://example.com/api/compatibility/compare", {
        method: "POST",
        body: JSON.stringify({ baselineRunId: "111" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "A comparison run id is required" });
  });

  it("returns a configuration error when artifact downloads cannot be authenticated", async () => {
    getGitHubToken.mockReturnValue(undefined);

    const response = await POST(
      new Request("https://example.com/api/compatibility/compare", {
        method: "POST",
        body: JSON.stringify({ baselineRunId: "111", targetRunId: "222" }),
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error:
        "GITHUB_TOKEN is not configured on the worker; deploy-suite artifact downloads require authentication.",
    });
  });
});

function createDb(rows: Array<{ runKey: string }>) {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(async () => rows),
  };
  return { select: vi.fn(() => query) };
}

function readAuthorization(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get("authorization");
  if (Array.isArray(headers)) {
    return headers.find(([name]) => name.toLowerCase() === "authorization")?.[1] ?? null;
  }
  return headers.Authorization ?? headers.authorization ?? null;
}

function zipReport(report: Report): ArrayBuffer {
  const fileName = Buffer.from("deploy-suite-report.json");
  const content = Buffer.from(JSON.stringify(report));
  const compressed = deflateRawSync(content);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(fileName.length, 26);

  const centralDirectory = Buffer.alloc(46);
  centralDirectory.writeUInt32LE(0x02014b50, 0);
  centralDirectory.writeUInt16LE(20, 4);
  centralDirectory.writeUInt16LE(20, 6);
  centralDirectory.writeUInt16LE(8, 10);
  centralDirectory.writeUInt32LE(compressed.length, 20);
  centralDirectory.writeUInt32LE(content.length, 24);
  centralDirectory.writeUInt16LE(fileName.length, 28);

  const centralDirectoryOffset = localHeader.length + fileName.length + compressed.length;
  const centralDirectorySize = centralDirectory.length + fileName.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDirectorySize, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);

  const zip = Buffer.concat([localHeader, fileName, compressed, centralDirectory, fileName, eocd]);
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}
