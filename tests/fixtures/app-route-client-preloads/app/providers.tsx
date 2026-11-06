"use client";

import type { ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  return <div data-testid="providers">{children}</div>;
}
