import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const getDb = vi.fn();

vi.mock("../apps/web/app/lib/db/client", () => ({ getDb }));

const { GET } = await import("../apps/web/app/api/compatibility/failures/route");

function createDb(queryResults: unknown[][]) {
  let queryIndex = 0;

  const createQuery = () => {
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      orderBy: vi.fn(() =>
        queryIndex === 0 ? query : Promise.resolve(queryResults[queryIndex++] ?? []),
      ),
      limit: vi.fn(async () => queryResults[queryIndex++] ?? []),
    };
    return query;
  };

  return { select: vi.fn(createQuery) };
}

describe("GET /api/compatibility/failures", () => {
  beforeEach(() => {
    getDb.mockReset();
  });

  it("returns failures from the latest deploy run", async () => {
    getDb.mockReturnValue(
      createDb([
        [
          {
            id: 42,
            kind: "deploy",
            runKey: "1234",
            vinextRef: "main",
            nextRef: "v16.2.6",
            commitSha: "abc123",
            createdAt: 1_750_000_000_000,
            total: 20,
            passed: 15,
            failed: 4,
            skipped: 1,
          },
        ],
        [
          {
            suite: "test/e2e/app-dir/example.test.ts",
            status: "partial",
            total: 5,
            passed: 1,
            failed: 4,
            skipped: 0,
          },
        ],
      ]),
    );

    const response = await GET(new Request("https://example.com/api/compatibility/failures"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "deploy",
      run: {
        id: 42,
        runKey: "1234",
        vinextRef: "main",
        nextRef: "v16.2.6",
        commitSha: "abc123",
        createdAt: 1_750_000_000_000,
        total: 20,
        passed: 15,
        failed: 4,
        skipped: 1,
      },
      failures: [
        {
          suite: "test/e2e/app-dir/example.test.ts",
          status: "partial",
          total: 5,
          passed: 1,
          failed: 4,
          skipped: 0,
        },
      ],
    });
  });

  it("returns an empty result when the requested kind has no runs", async () => {
    getDb.mockReturnValue(createDb([[]]));

    const response = await GET(
      new Request("https://example.com/api/compatibility/failures?kind=vitest"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "vitest", run: null, failures: [] });
  });

  it("returns 500 when the database query fails", async () => {
    getDb.mockImplementation(() => {
      throw new Error("DB unavailable");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET(new Request("https://example.com/api/compatibility/failures"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to load failing tests" });
  });
});
