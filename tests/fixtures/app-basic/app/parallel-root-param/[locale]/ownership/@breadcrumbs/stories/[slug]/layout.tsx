import type { ReactNode } from "react";

export function generateStaticParams() {
  return [{ locale: "en" }];
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
