"use cache";

import { cacheLife } from "next/cache";

export default async function UseCacheCustomProfilePage() {
  // Configured in next.config.ts `cacheLife`.
  cacheLife("customProfile");

  return (
    <div data-testid="use-cache-custom-profile-page">
      <h1>Use Cache Custom Profile</h1>
      <p>
        Timestamp: <span data-testid="timestamp">{Date.now()}</span>
      </p>
    </div>
  );
}
