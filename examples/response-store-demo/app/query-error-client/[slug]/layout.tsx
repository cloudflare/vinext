import type { ReactNode } from "react";

export const dynamic = "error";
export const revalidate = 60;

export function generateStaticParams() {
  return [];
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
