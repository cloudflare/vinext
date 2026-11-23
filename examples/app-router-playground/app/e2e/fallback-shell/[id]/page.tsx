import { cacheLife } from 'next/cache';
import { Suspense } from 'react';

// A route for tests/e2e/cloudflare-workers/fallback-shell.spec.ts: paths
// outside generateStaticParams resume the shell rendered for `[id]`.
export async function generateStaticParams() {
  return [{ id: 'generated' }];
}

async function getRenderedAt() {
  'use cache';
  // Stale within a second, so a shell rendered later refreshes it.
  cacheLife({ revalidate: 1 });
  return new Date().toISOString();
}

async function Param({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="param">{id}</p>;
}

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <main>
      <p id="rendered-at">{await getRenderedAt()}</p>
      <Suspense fallback={<p id="param-loading">Loading…</p>}>
        <Param params={params} />
      </Suspense>
    </main>
  );
}
