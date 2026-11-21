"use cache";

// A cache module's server references, not this body, reach the browser.
const MTS_CACHE_SERVER_MARKER = "mts-cache-server-marker";

export async function getMtsCachedMessage(value: string) {
  return `client-mts-cache:${value}:${MTS_CACHE_SERVER_MARKER}:${Math.random()}`;
}
