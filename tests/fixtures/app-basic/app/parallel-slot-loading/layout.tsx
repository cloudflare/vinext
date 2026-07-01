import type { ReactNode } from "react";

export default function Layout({ children, slow }: { children: ReactNode; slow: ReactNode }) {
  return (
    <main>
      {children}
      {slow}
    </main>
  );
}
