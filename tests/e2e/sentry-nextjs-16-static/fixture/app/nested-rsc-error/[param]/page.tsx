import { Suspense } from 'react';

export const dynamic = 'force-dynamic';

export default async function Page() {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      {/* @ts-ignore */}
      <Crash />;
    </Suspense>
  );
}

async function Crash() {
  throw new Error('I am technically uncatchable');
  return <p>unreachable</p>;
}
