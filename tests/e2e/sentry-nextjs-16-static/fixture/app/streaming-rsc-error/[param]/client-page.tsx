'use client';

import { use } from 'react';

export function RenderPromise({ stringPromise }: { stringPromise: Promise<string> }) {
  const s = use(stringPromise);
  return <>{s}</>;
}
