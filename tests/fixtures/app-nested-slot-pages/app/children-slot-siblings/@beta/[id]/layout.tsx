import type { ReactNode } from "react";

export const dynamicParams = false;

export default function Layout({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}
