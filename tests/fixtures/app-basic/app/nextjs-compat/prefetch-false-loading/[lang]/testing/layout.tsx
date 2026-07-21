import type { ReactNode } from "react";

export default function TestingLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <p id="prefetch-false-loading-layout">Nested Layout</p>
      {children}
    </div>
  );
}
