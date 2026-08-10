"use cache";

import type { ReactNode } from "react";

export default async function CachedLayout({ children }: { children: ReactNode }) {
  return (
    <section>
      <p data-testid="cached-layout-value">{Math.random()}</p>
      {children}
    </section>
  );
}
