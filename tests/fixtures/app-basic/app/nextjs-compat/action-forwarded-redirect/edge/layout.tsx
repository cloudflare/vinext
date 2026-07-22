import type { ReactNode } from "react";

export const runtime = "edge";

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
