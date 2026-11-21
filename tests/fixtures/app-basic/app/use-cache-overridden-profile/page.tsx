"use cache";

import { cacheLife } from "next/cache";

export default async function UseCacheOverriddenProfilePage() {
  // next.config.ts `cacheLife` replaces the built-in "minutes" profile.
  cacheLife("minutes");

  return (
    <div data-testid="use-cache-overridden-profile-page">
      <h1>Use Cache Overridden Profile</h1>
    </div>
  );
}
