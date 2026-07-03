/** Cloudflare KV bulk upload helpers shared by deploy-time cache population. */

/** KV bulk API accepts up to 10,000 pairs per request. */
export const KV_BATCH_SIZE = 10_000;

/** Default KV expiration TTL used by KVCacheHandler for revalidating entries. */
export const DEFAULT_KV_TTL_SECONDS = 30 * 24 * 3600;

export type KVBulkPair = {
  key: string;
  value: string;
  expiration_ttl?: number;
  metadata?: Record<string, unknown>;
};

export async function resolveAccountId(apiToken: string): Promise<string | null> {
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=1", {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    success: boolean;
    result?: Array<{ id: string }>;
  };
  if (!data.success || !data.result?.length) return null;

  return data.result[0].id;
}

export async function uploadKVPairs(
  pairs: readonly KVBulkPair[],
  namespaceId: string,
  accountId: string,
  apiToken: string,
): Promise<void> {
  for (let i = 0; i < pairs.length; i += KV_BATCH_SIZE) {
    const batch = pairs.slice(i, i + KV_BATCH_SIZE);
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `KV bulk upload failed (batch ${Math.floor(i / KV_BATCH_SIZE) + 1}): ${response.status} - ${text}`,
      );
    }
  }
}
