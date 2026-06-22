import { fileURLToPath } from "node:url";

export type KvCdnAdapterOptions = {
  binding?: string;
  appPrefix?: string;
  ttlSeconds?: number;
  tagCacheTtlMs?: number;
};

export function kvCdnAdapter(options?: KvCdnAdapterOptions) {
  if (options?.binding !== undefined && typeof options.binding !== "string") {
    throw new TypeError("[vinext] kvCdnAdapter({ binding }) must be a string KV binding name.");
  }
  return {
    adapter: fileURLToPath(import.meta.resolve("./kv-cdn-adapter.runtime.js")),
    options,
  };
}
