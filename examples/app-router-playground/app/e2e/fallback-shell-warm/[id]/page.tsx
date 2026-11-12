import { cacheLife } from 'next/cache';
import { Suspense } from 'react';

// A route for tests/e2e/cloudflare-workers/fallback-shell.spec.ts: warming
// `generated` also stores the `[id]` shell. A shell rendered later would
// refresh the stale time first, so a stored one shows when it was warmed.
export async function generateStaticParams() {
  return [{ id: 'generated' }];
}

async function getRenderedAt() {
  'use cache';
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
