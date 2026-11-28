import type { ReactNode } from "react";

export default function DashboardLayout({
  children,
  analytics,
}: {
  children: ReactNode;
  analytics: ReactNode;
}) {
  return (
    <>
      {children}
      {analytics}
    </>
  );
}
