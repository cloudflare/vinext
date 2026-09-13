import type { ReactNode } from "react";

export default function OptimisticSearchNavigationLayout({
  children,
  modal,
}: {
  children: ReactNode;
  modal?: ReactNode;
}) {
  return (
    <div data-testid="provider-list-layout">
      {children}
      {modal}
    </div>
  );
}
