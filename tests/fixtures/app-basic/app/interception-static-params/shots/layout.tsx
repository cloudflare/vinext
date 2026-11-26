import type { ReactNode } from "react";

export default function Layout({ children, modal }: { children: ReactNode; modal: ReactNode }) {
  return (
    <div>
      <div data-testid="shots-children">{children}</div>
      <div data-testid="shots-modal">{modal}</div>
    </div>
  );
}
