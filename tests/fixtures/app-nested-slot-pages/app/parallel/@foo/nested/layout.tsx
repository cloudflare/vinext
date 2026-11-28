import type { ReactNode } from "react";

export default function Layout({ children, a }: { children: ReactNode; a: ReactNode }) {
  return (
    <div>
      {a}
      {children}
    </div>
  );
}
