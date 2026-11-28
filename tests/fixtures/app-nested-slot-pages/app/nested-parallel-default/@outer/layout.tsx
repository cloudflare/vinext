import type { ReactNode } from "react";

export default function Layout({ children, inner }: { children: ReactNode; inner: ReactNode }) {
  return (
    <div>
      {children}
      {inner}
    </div>
  );
}
