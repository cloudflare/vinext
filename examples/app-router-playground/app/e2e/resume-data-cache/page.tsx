import { cacheTag } from 'next/cache';
import { connection } from 'next/server';
import { Suspense } from 'react';

// A route for tests/e2e/cloudflare-workers/resume-data-cache.spec.ts, ported
// from Next.js: test/e2e/app-dir/resume-data-cache/app/page.tsx
async function getRandomNumber() {
  'use cache';
  cacheTag('e2e-resume-data-cache');
  return Math.random();
}

async function DynamicComponent() {
  await connection();
  return null;
}

export default async function Page() {
  return (
    <main>
      <p id="random-number">{await getRandomNumber()}</p>
      <Suspense>
        <DynamicComponent />
      </Suspense>
    </main>
  );
}
