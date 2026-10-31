import type { ReactNode } from "react";

export default async function LateNestedLayout({ children }: { children: ReactNode }) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return <div>{children}</div>;
}
