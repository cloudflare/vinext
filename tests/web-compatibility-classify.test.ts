import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const getDb = vi.fn();
const getIngestSecret = vi.fn();

vi.mock("@/app/lib/db/client", () => ({ getDb, getIngestSecret }));
// The route imports the schema through the app's `@/` alias.
vi.mock("@/app/lib/db/schema", () => import("../apps/web/app/lib/db/schema"));

const { POST } = await import("../apps/web/app/api/compatibility/classify/route");

function createDb() {
  const values = vi.fn();
  const onConflictDoUpdate = vi.fn(() => ({ type: "upsert" }));
  values.mockImplementation(() => ({ onConflictDoUpdate }));
  const db = {
    insert: vi.fn(() => ({ values })),
    batch: vi.fn(async () => []),
  };
  return { db, values, onConflictDoUpdate };
}

function request(body: Record<string, unknown>) {
  return new Request("https://example.com/api/compatibility/classify", {
    method: "POST",
    headers: { "content-type": "application/json", "x-compat-secret": "test-secret" },
    body: JSON.stringify({
      nextRef: "v16.4.6",
      classifiedAt: 1_790_000_000_000,
      suites: [{ suite: "test/e2e/app-dir/example.test.ts", router: "app" }],
      ...body,
    }),
  });
}

describe("POST /api/compatibility/classify", () => {
  beforeEach(() => {
    getDb.mockReset();
    getIngestSecret.mockReset();
    getIngestSecret.mockReturnValue("test-secret");
  });

  it("stores classifications under their Next.js version without replacing newer ones", async () => {
    const { db, values, onConflictDoUpdate } = createDb();
    getDb.mockReturnValue(db);

    const response = await POST(request({}));

    expect(response.status).toBe(200);
    expect(values).toHaveBeenCalledWith([
      {
        nextRef: "v16.4.6",
        suite: "test/e2e/app-dir/example.test.ts",
        router: "app",
        classifiedAt: 1_790_000_000_000,
      },
    ]);
    const [{ target, setWhere }] = onConflictDoUpdate.mock.calls[0] as unknown as [
      { target: { name: string }[]; setWhere: unknown },
    ];
    expect(target.map((column) => column.name)).toEqual(["next_ref", "suite"]);
    expect(setWhere).toBeDefined();
  });

  it.each([Date.now() + 86_400_000, 1_790_000_000_000.5])(
    "rejects an invalid classification time: %s",
    async (classifiedAt) => {
      const response = await POST(request({ classifiedAt }));

      expect(response.status).toBe(400);
      expect(getDb).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "refs/heads/canary"])(
    "rejects an invalid Next.js version: %s",
    async (nextRef) => {
      const response = await POST(request({ nextRef }));

      expect(response.status).toBe(400);
      expect(getDb).not.toHaveBeenCalled();
    },
  );
});
