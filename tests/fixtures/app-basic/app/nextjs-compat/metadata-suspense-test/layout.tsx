import { Suspense } from "react";

export default function SuspenseLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div>loading...</div>}>{children}</Suspense>;
}
