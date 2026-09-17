import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupResponseStoreVersions,
  responseStoreCleanupCutoff,
} from "../packages/cloudflare/src/response-store-cleanup.js";

const OLD_VERSION = "11111111-1111-4111-8111-111111111111";
const DEPLOYED_VERSION = "22222222-2222-4222-8222-222222222222";
const NEW_VERSION = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
  delete process.env.CLOUDFLARE_API_TOKEN;
  vi.restoreAllMocks();
});

describe("Response Store version cleanup", () => {
  it("parses supported age units", () => {
    const now = Date.parse("2026-09-17T12:00:00.000Z");
    expect(responseStoreCleanupCutoff("24h", now).toISOString()).toBe("2026-09-16T12:00:00.000Z");
    expect(responseStoreCleanupCutoff("2w", now).toISOString()).toBe("2026-09-03T12:00:00.000Z");
    expect(() => responseStoreCleanupCutoff("yesterday", now)).toThrow(
      '--older-than expects a duration such as "24h", "7d", or "4w".',
    );
  });

  it("selects old versions while protecting the current deployment", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith("/versions")) {
        return Response.json({
          success: true,
          result: {
            items: [
              { id: OLD_VERSION, metadata: { created_on: "2026-08-01T00:00:00.000Z" } },
              {
                id: DEPLOYED_VERSION,
                metadata: { created_on: "2026-08-02T00:00:00.000Z" },
              },
              { id: NEW_VERSION, metadata: { created_on: "2026-09-17T00:00:00.000Z" } },
            ],
          },
        });
      }
      if (url.pathname.endsWith("/deployments")) {
        return Response.json({
          success: true,
          result: {
            deployments: [{ versions: [{ version_id: DEPLOYED_VERSION, percentage: 100 }] }],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const unstable_readConfig = vi.fn(() => ({
      account_id: "account-id",
      name: "app-worker",
      services: [
        {
          binding: "RESPONSE_STORE",
          entrypoint: "ResponseStoreService",
          service: "cache-worker",
        },
      ],
    }));

    const result = await cleanupResponseStoreVersions(
      {
        root: "/project",
        olderThan: "7d",
        shardCounts: [1, 16],
        yes: false,
      },
      {
        fetch: fetch as typeof globalThis.fetch,
        loadWrangler: async () => ({ unstable_readConfig }) as never,
        now: Date.parse("2026-09-17T12:00:00.000Z"),
      },
    );

    expect(result.selectedVersions.map(({ id }) => id)).toEqual([OLD_VERSION]);
    expect(result.protectedVersionIds).toEqual([DEPLOYED_VERSION]);
    expect(result.deletions).toEqual([]);
    expect(unstable_readConfig).toHaveBeenCalledWith(
      { config: undefined, env: undefined },
      { hideWarnings: true, preserveOriginalMain: true, useRedirectIfAvailable: true },
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("deletes a version selected by id", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith("/versions")) {
        return Response.json({
          success: true,
          result: {
            items: [
              { id: OLD_VERSION, metadata: { created_on: "2026-08-01T00:00:00.000Z" } },
              { id: NEW_VERSION, metadata: { created_on: "2026-09-17T00:00:00.000Z" } },
            ],
          },
        });
      }
      if (url.pathname.endsWith("/deployments")) {
        return Response.json({ success: true, result: { deployments: [{ versions: [] }] } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const deleteVersionStorage = vi.fn(async () => []);
    const wrangler = {
      unstable_readConfig: () => ({ account_id: "account-id", name: "app-worker" }),
    } as never;
    const result = await cleanupResponseStoreVersions(
      {
        root: "/project",
        versionId: NEW_VERSION,
        shardCounts: [1, 16],
        yes: true,
      },
      {
        deleteVersionStorage,
        fetch: fetch as typeof globalThis.fetch,
        loadWrangler: async () => wrangler,
      },
    );

    expect(result.cutoff).toBeUndefined();
    expect(result.selectedVersions.map(({ id }) => id)).toEqual([NEW_VERSION]);
    expect(deleteVersionStorage).toHaveBeenCalledWith(wrangler, "account-id", "app-worker", [
      { versionId: NEW_VERSION },
      { versionId: NEW_VERSION, shards: 16 },
    ]);
  });

  it("requires exactly one version selector", async () => {
    const options = { root: "/project", shardCounts: [1], yes: false };

    await expect(cleanupResponseStoreVersions(options)).rejects.toThrow(
      "Exactly one of --older-than or --version-id is required.",
    );
    await expect(
      cleanupResponseStoreVersions({ ...options, olderThan: "7d", versionId: OLD_VERSION }),
    ).rejects.toThrow("Exactly one of --older-than or --version-id is required.");
  });

  it("rechecks deployment traffic before deleting", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    let deploymentRequest = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith("/versions")) {
        return Response.json({
          success: true,
          result: {
            items: [{ id: OLD_VERSION, metadata: { created_on: "2026-08-01T00:00:00.000Z" } }],
          },
        });
      }
      if (url.pathname.endsWith("/deployments")) {
        deploymentRequest++;
        return Response.json({
          success: true,
          result: {
            deployments: [
              {
                versions:
                  deploymentRequest === 1 ? [] : [{ version_id: OLD_VERSION, percentage: 100 }],
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const deleteVersionStorage = vi.fn();

    await expect(
      cleanupResponseStoreVersions(
        {
          root: "/project",
          olderThan: "7d",
          shardCounts: [16],
          yes: true,
        },
        {
          deleteVersionStorage,
          fetch: fetch as typeof globalThis.fetch,
          loadWrangler: async () =>
            ({
              unstable_readConfig: () => ({
                account_id: "account-id",
                name: "app-worker",
                services: [{ binding: "RESPONSE_STORE", service: "cache-worker" }],
              }),
            }) as never,
          now: Date.parse("2026-09-17T12:00:00.000Z"),
        },
      ),
    ).rejects.toThrow(
      `Worker deployment changed during cleanup; refusing to delete active version ${OLD_VERSION}.`,
    );
    expect(deleteVersionStorage).not.toHaveBeenCalled();
  });
});
