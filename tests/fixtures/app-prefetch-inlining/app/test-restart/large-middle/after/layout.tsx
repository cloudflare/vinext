import type { ReactNode } from "react";

export default function AfterLayout({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}
