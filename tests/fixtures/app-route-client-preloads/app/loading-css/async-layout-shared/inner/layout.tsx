import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default async function AsyncLayout({ children }: { children: ReactNode }) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return <section>{children}</section>;
}
