const EDGE_RETRY_TIMEOUT_MS = 30_000;

/**
 * For about a minute after a new workers.dev Worker deploys, the edge fails
 * some requests with a 500 before the Worker runs, even after readiness probes
 * pass. The example Workers mark every response they produce, so an unmarked
 * response never reached the Worker and is safe to retry, writes included.
 */
export async function liveFetch(url: string, init?: RequestInit): Promise<Response> {
  const deadline = Date.now() + EDGE_RETRY_TIMEOUT_MS;
  while (true) {
    const response = await fetch(url, init);
    if (response.headers.has("X-Response-Store-Fixture") || Date.now() >= deadline) {
      return response;
    }
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
