import type { ReactNode } from "react";

// Next.js passes a nested route only its ancestor layouts' params, so the
// [item] page's generateStaticParams reads { category } from here.
export async function generateStaticParams() {
  return [{ category: "electronics" }, { category: "clothing" }];
}

export default function CategoryLayout({ children }: { children: ReactNode }) {
  return children;
}
