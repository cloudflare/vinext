import type { ReactNode } from "react";

export default function Layout({ children, outer }: { children: ReactNode; outer: ReactNode }) {
  return (
    <div>
      {children}
      {outer}
    </div>
  );
}
