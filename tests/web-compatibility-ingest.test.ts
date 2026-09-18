import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const getDb = vi.fn();
const getIngestSecret = vi.fn();

vi.mock("@/app/lib/db/client", () => ({ getDb, getIngestSecret }));
vi.mock("@/app/lib/db/schema", () => ({
  compatRuns: { kind: "kind", runKey: "runKey" },
  compatFileResults: { runId: "runId" },
}));

const { POST } = await import("../apps/web/app/api/compatibility/route");

function createDb() {
  const inserted: unknown[] = [];
  const upsert = {
    onConflictDoUpdate: vi.fn(() => upsert),
    returning: vi.fn(async () => [{ id: 1 }]),
  };
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((value: unknown) => {
        inserted.push(value);
        return inserted.length === 1 ? upsert : { type: "insert" };
      }),
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => ({ type: "delete" })) })),
    batch: vi.fn(async () => []),
  };
  return { db, inserted };
}

function request(createdAt: unknown, backfill = true) {
  const commitSha = "0123456789abcdef0123456789abcdef01234567";
  return new Request("https://example.com/api/compatibility", {
    method: "POST",
    headers: { "content-type": "application/json", "x-compat-secret": "test-secret" },
    body: JSON.stringify({
      kind: "deploy",
      runKey: backfill ? `backfill:2026-04-01:${commitSha}` : "1234",
      vinextRef: backfill ? commitSha : "main",
      nextRef: "v16.2.6",
      commitSha: backfill ? commitSha : "abcdef",
      createdAt,
      files: [
        {
          suite: "test/e2e/app-dir/example.test.ts",
          total: 1,
          passed: 1,
          failed: 0,
          skipped: 0,
        },
      ],
    }),
  });
}

describe("POST /api/compatibility", () => {
  beforeEach(() => {
    getDb.mockReset();
    getIngestSecret.mockReset();
    getIngestSecret.mockReturnValue("test-secret");
  });

  it("stores an authenticated historical timestamp", async () => {
    const createdAt = Date.parse("2026-04-01T02:00:00Z");
    const { db, inserted } = createDb();
    getDb.mockReturnValue(db);

    const response = await POST(request(createdAt));

    expect(response.status).toBe(200);
    expect(inserted[0]).toMatchObject({ createdAt });
  });

  it("continues to timestamp ordinary ingest at write time", async () => {
    const before = Date.now();
    const { db, inserted } = createDb();
    getDb.mockReturnValue(db);

    const response = await POST(request(undefined, false));

    expect(response.status).toBe(200);
    expect(inserted[0]).toMatchObject({ createdAt: expect.any(Number) });
    expect((inserted[0] as { createdAt: number }).createdAt).toBeGreaterThanOrEqual(before);
  });

  it.each([undefined, -1, 1.5, Date.now() + 86_400_000, "2026-04-01"])(
    "rejects an invalid historical timestamp: %s",
    async (createdAt) => {
      const response = await POST(request(createdAt));

      expect(response.status).toBe(400);
      expect(getDb).not.toHaveBeenCalled();
    },
  );
});
