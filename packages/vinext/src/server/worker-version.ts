import { isUnknownRecord } from "../utils/record.js";

export const VINEXT_VERSION_METADATA_BINDING = "VINEXT_VERSION_METADATA";
export const VINEXT_WORKER_VERSION_HEADER = "x-vinext-worker-version";

type WorkerVersionMetadataLike = {
  id: string;
  tag: string;
  timestamp: string;
};

function isWorkerVersionMetadata(value: unknown): value is WorkerVersionMetadataLike {
  return (
    isUnknownRecord(value) &&
    typeof value.id === "string" &&
    typeof value.tag === "string" &&
    typeof value.timestamp === "string"
  );
}

function readWorkerVersionId(env: unknown): string | null {
  if (!isUnknownRecord(env)) return null;
  const metadata = env[VINEXT_VERSION_METADATA_BINDING];
  return isWorkerVersionMetadata(metadata) ? metadata.id : null;
}

/**
 * Stamp the producing Worker version onto the response representation. The
 * edge stores this header with cacheable responses, so a later cache HIT still
 * identifies the version that produced the cached body rather than whichever
 * deployment is currently active.
 */
export function stampWorkerVersion(response: Response, env: unknown): Response {
  const versionId = readWorkerVersionId(env);
  // Response.error() has status 0 and cannot be reconstructed with the public
  // Response constructor. WebSocket upgrade responses similarly carry host
  // state that must not be cloned.
  if (!versionId || response.status === 0 || response.status === 101) return response;

  try {
    response.headers.set(VINEXT_WORKER_VERSION_HEADER, versionId);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(VINEXT_WORKER_VERSION_HEADER, versionId);
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
}
