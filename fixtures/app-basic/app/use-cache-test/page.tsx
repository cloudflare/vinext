"use cache";

import { cacheLife, cacheTag } from "next/cache";

// File-level "use cache" — all exports from this file are cached.
// Uses the "seconds" profile (revalidate: 1s) so tests can verify caching
// and expiration in a short window.

export default async function UseCacheTestPage() {
  cacheLife("seconds");
  cacheTag("use-cache-test");

  const timestamp = Date.now();

  return (
    <div data-testid="use-cache-test-page">
      <h1>Use Cache Test</h1>
      <p>
        Timestamp: <span data-testid="timestamp">{timestamp}</span>
      </p>
      <p data-testid="message">This page uses the &quot;use cache&quot; directive</p>
    </div>
  );
}
