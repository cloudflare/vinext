import { cacheTag } from 'next/cache';
import { Suspense } from 'react';
import { refreshAction } from './actions';

// A route for tests/e2e/cloudflare-workers/resume-data-cache.spec.ts, ported
// from Next.js: test/e2e/app-dir/resume-data-cache/app/server-action/page.tsx
async function getCachedRandomNumber() {
  'use cache';
  cacheTag('e2e-resume-data-cache-server-action');
  await new Promise((resolve) => setTimeout(resolve, 100));
  return Math.random();
}

async function getUncachedRandomNumber() {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return Math.random();
}

async function DynamicComponent() {
  return <p id="uncached-random">{await getUncachedRandomNumber()}</p>;
}

export default async function Page() {
  return (
    <main>
      <p id="cached-random">{await getCachedRandomNumber()}</p>
      <form action={refreshAction}>
        <button id="refresh-button" type="submit">
          Refresh
        </button>
      </form>
      <Suspense fallback={<p id="uncached-random">Loading...</p>}>
        <DynamicComponent />
      </Suspense>
    </main>
  );
}
