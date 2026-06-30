import type { ReactNode } from "react";

export function generateStaticParams() {
  return [{ slug: "static-123" }];
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
