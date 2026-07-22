import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div>
      <div style={{ display: "none" }}>{"x".repeat(3000)}</div>
      {children}
    </div>
  );
}
