import type { ReactNode } from "react";

// Runs after the owner's `default`, as children comes before the slots.
export function generateStaticParams({ params }: { params: { slug?: string } }) {
  return [{ id: params.slug === "acme" ? "1" : "2" }];
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
