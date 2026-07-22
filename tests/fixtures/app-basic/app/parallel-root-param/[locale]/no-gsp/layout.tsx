import type { ReactNode } from "react";

export default function Layout({
  breadcrumbs,
  children,
}: {
  breadcrumbs: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div data-testid="parallel-root-breadcrumbs">{breadcrumbs}</div>
      {children}
    </>
  );
}
