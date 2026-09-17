import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ResponseStoreVersionStorageDeletion,
  ResponseStoreVersionStorageDeletionResult,
} from "@cloudflare/workers-response-store";

type WorkerVersion = {
  id: string;
  metadata: { created_on: string };
};

type WranglerConfig = {
  account_id?: string;
  name?: string;
  services?: Array<{ binding?: string; entrypoint?: string; service?: string }>;
};

type WranglerWorker = {
  ready: Promise<unknown>;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
};

type WranglerApi = {
  unstable_readConfig(
    args: { config?: string; env?: string },
    options: {
      hideWarnings: true;
      preserveOriginalMain: true;
      useRedirectIfAvailable: true;
    },
  ): WranglerConfig;
  unstable_startWorker(options: {
    config: string;
    dev: {
      inspector: false;
      logLevel: "none";
      persist: false;
      server: { port: 0 };
      watch: false;
    };
  }): Promise<WranglerWorker>;
};

type ApiEnvelope<T> = {
  success: boolean;
  result?: T;
  errors?: Array<{ message?: string }>;
};

export type ResponseStoreCleanupOptions = {
  root: string;
  olderThan: string;
  shardCounts: number[];
  yes: boolean;
  config?: string;
  env?: string;
  workerName?: string;
  responseStoreWorker?: string;
};

export type ResponseStoreCleanupResult = {
  cutoff: string;
  protectedVersionIds: string[];
  selectedVersions: WorkerVersion[];
  deletions: ResponseStoreVersionStorageDeletionResult[];
};

function parseDuration(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(m|h|d|w)$/.exec(raw.trim());
  if (!match) {
    throw new Error('--older-than expects a duration such as "24h", "7d", or "4w".');
  }
  const units = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
  const duration = Number(match[1]) * units[match[2] as keyof typeof units];
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new Error(`Invalid --older-than duration: ${raw}`);
  }
  return duration;
}

export function responseStoreCleanupCutoff(olderThan: string, now = Date.now()): Date {
  return new Date(now - parseDuration(olderThan));
}

async function cloudflareApi<T>(
  pathname: string,
  apiToken: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4${pathname}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !body.success || body.result === undefined) {
    throw new Error(
      body.errors
        ?.map(({ message }) => message)
        .filter(Boolean)
        .join(", ") || `Cloudflare API request failed with HTTP ${response.status}`,
    );
  }
  return body.result;
}

async function resolveAccountId(
  configuredAccountId: string | undefined,
  apiToken: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (configuredAccountId) return configuredAccountId;
  const accounts = await cloudflareApi<Array<{ id: string }>>(
    "/accounts?per_page=2",
    apiToken,
    fetchImpl,
  );
  if (!accounts.length) {
    throw new Error("Could not resolve a Cloudflare account. Set CLOUDFLARE_ACCOUNT_ID.");
  }
  if (accounts.length > 1) {
    throw new Error("The API token can access multiple accounts. Set CLOUDFLARE_ACCOUNT_ID.");
  }
  return accounts[0].id;
}

async function listWorkerVersions(
  accountId: string,
  workerName: string,
  apiToken: string,
  fetchImpl: typeof fetch,
): Promise<WorkerVersion[]> {
  const versions: WorkerVersion[] = [];
  for (let page = 1; ; page++) {
    const result = await cloudflareApi<{ items: WorkerVersion[] }>(
      `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/versions?page=${page}&per_page=100`,
      apiToken,
      fetchImpl,
    );
    versions.push(...result.items);
    if (result.items.length < 100) return versions;
  }
}

async function currentDeploymentVersionIds(
  accountId: string,
  workerName: string,
  apiToken: string,
  fetchImpl: typeof fetch,
): Promise<Set<string>> {
  const { deployments } = await cloudflareApi<{
    deployments: Array<{ versions: Array<{ version_id: string }> }>;
  }>(
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/deployments`,
    apiToken,
    fetchImpl,
  );
  return new Set((deployments[0]?.versions ?? []).map(({ version_id }) => version_id));
}

async function loadWrangler(root: string): Promise<WranglerApi> {
  const require = createRequire(path.join(root, "package.json"));
  let modulePath: string;
  try {
    modulePath = require.resolve("wrangler");
  } catch {
    modulePath = createRequire(require.resolve("@cloudflare/vite-plugin")).resolve("wrangler");
  }
  return (await import(pathToFileURL(modulePath).href)) as WranglerApi;
}

async function deleteVersionStorage(
  wrangler: WranglerApi,
  accountId: string,
  responseStoreWorker: string,
  inputs: ResponseStoreVersionStorageDeletion[],
): Promise<ResponseStoreVersionStorageDeletionResult[]> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vinext-response-store-cleanup-"));
  const entry = path.join(directory, "worker.mjs");
  const config = path.join(directory, "wrangler.json");
  await writeFile(
    entry,
    `export default { async fetch(request, env) {
      try {
        const results = [];
        for (const input of await request.json()) {
          results.push(await env.ADMIN.deleteVersionStorage(input));
        }
        return Response.json(results);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    } };\n`,
  );
  await writeFile(
    config,
    JSON.stringify({
      account_id: accountId,
      compatibility_date: "2026-09-16",
      main: entry,
      name: `vinext-response-store-cleanup-${randomUUID()}`,
      services: [
        {
          binding: "ADMIN",
          entrypoint: "ResponseStoreAdmin",
          remote: true,
          service: responseStoreWorker,
        },
      ],
    }),
  );

  let worker: WranglerWorker | undefined;
  try {
    worker = await wrangler.unstable_startWorker({
      config,
      dev: {
        inspector: false,
        logLevel: "none",
        persist: false,
        server: { port: 0 },
        watch: false,
      },
    });
    await worker.ready;
    const response = await worker.fetch("http://response-store-cleanup.invalid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inputs),
    });
    const body = (await response.json()) as
      | ResponseStoreVersionStorageDeletionResult[]
      | { error?: string };
    if (!response.ok || !Array.isArray(body)) {
      throw new Error(!Array.isArray(body) && body.error ? body.error : "Cleanup Worker failed");
    }
    return body;
  } finally {
    await worker?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function cleanupResponseStoreVersions(
  options: ResponseStoreCleanupOptions,
  dependencies: {
    deleteVersionStorage?: typeof deleteVersionStorage;
    fetch?: typeof fetch;
    loadWrangler?: typeof loadWrangler;
    now?: number;
  } = {},
): Promise<ResponseStoreCleanupResult> {
  const shardCounts = [...new Set(options.shardCounts)];
  if (
    shardCounts.length === 0 ||
    shardCounts.some((count) => !Number.isSafeInteger(count) || count < 1)
  ) {
    throw new Error("Response Store cleanup requires at least one positive shard count.");
  }
  const cutoff = responseStoreCleanupCutoff(options.olderThan, dependencies.now ?? Date.now());
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required.");

  const fetchImpl = dependencies.fetch ?? fetch;
  const wrangler = await (dependencies.loadWrangler ?? loadWrangler)(options.root);
  const config = wrangler.unstable_readConfig(
    { config: options.config, env: options.env },
    { hideWarnings: true, preserveOriginalMain: true, useRedirectIfAvailable: true },
  );
  const workerName = options.workerName ?? config.name;
  if (!workerName)
    throw new Error("Set the application Worker name with --name or Wrangler config.");
  const responseStoreWorker =
    options.responseStoreWorker ??
    config.services?.find(
      ({ binding, entrypoint }) =>
        binding === "RESPONSE_STORE" || entrypoint === "ResponseStoreService",
    )?.service ??
    workerName;
  const accountId = await resolveAccountId(
    config.account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken,
    fetchImpl,
  );
  const [versions, protectedVersionIds] = await Promise.all([
    listWorkerVersions(accountId, workerName, apiToken, fetchImpl),
    currentDeploymentVersionIds(accountId, workerName, apiToken, fetchImpl),
  ]);
  const selectedVersions = versions.filter(
    ({ id, metadata }) => new Date(metadata.created_on) < cutoff && !protectedVersionIds.has(id),
  );
  const inputs = selectedVersions.flatMap(({ id: versionId }) =>
    shardCounts.map((shards): ResponseStoreVersionStorageDeletion => ({
      versionId,
      ...(shards === 1 ? {} : { shards }),
    })),
  );
  let deletions: ResponseStoreVersionStorageDeletionResult[] = [];
  if (options.yes && inputs.length) {
    const currentVersionIds = await currentDeploymentVersionIds(
      accountId,
      workerName,
      apiToken,
      fetchImpl,
    );
    const newlyProtected = selectedVersions.filter(({ id }) => currentVersionIds.has(id));
    if (newlyProtected.length) {
      throw new Error(
        `Worker deployment changed during cleanup; refusing to delete active version ${newlyProtected[0].id}.`,
      );
    }
    deletions = await (dependencies.deleteVersionStorage ?? deleteVersionStorage)(
      wrangler,
      accountId,
      responseStoreWorker,
      inputs,
    );
  }

  return {
    cutoff: cutoff.toISOString(),
    protectedVersionIds: [...protectedVersionIds],
    selectedVersions,
    deletions,
  };
}
