import { scopedSecret } from "../runtime-settings/settings";
import { executeGraphOp } from "./ops";
import type { PrefetchStore } from "./prefetch-state";
import { opCacheKey } from "./prefetch-state";

export type ServerGraphHandleOptions = {
  url: string;
  token: string;
  handleName: string;
  prefetch?: PrefetchStore;
};

/**
 * Options-from-env: credentials resolve from the environment under the
 * calling product's credential scope, and the handle identifies itself per
 * view kind (`atlas-detail`, `atlas-gallery`, ...) for observability.
 */
export const graphHandleOptionsFromEnv = (
  env: NodeJS.ProcessEnv,
  { credentialScope, handleName }: { credentialScope: string; handleName: string },
): ServerGraphHandleOptions => ({
  url: env["ATLAS_DATA_EDGE_URL"] ?? "/api/graph",
  token: scopedSecret(credentialScope, "DATA_EDGE_TOKEN") ?? "dev-loopback-token",
  handleName,
});

export type ServerGraphHandle = {
  run<T = unknown>(op: string, variables?: Record<string, unknown>): Promise<T>;
};

export const openServerGraphHandle = (
  options: ServerGraphHandleOptions,
): ServerGraphHandle => {
  return {
    async run<T>(op: string, variables: Record<string, unknown> = {}) {
      const data = (await executeGraphOp(op, variables)) as T;
      options.prefetch?.write(opCacheKey(op, variables), data);
      return data;
    },
  };
};
