import type { ReactNode } from "react";

export function generateStaticParams() {
  return [{ slug: "a" }];
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
