import { Suspense } from 'react';
import { RenderPromise } from './client-page';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const crashingPromise = new Promise<string>((_, reject) => {
    setTimeout(() => {
      reject(new Error('I am a data streaming error'));
    }, 100);
  });

  return (
    <Suspense fallback={<p>Loading...</p>}>
      <RenderPromise stringPromise={crashingPromise} />;
    </Suspense>
  );
}
