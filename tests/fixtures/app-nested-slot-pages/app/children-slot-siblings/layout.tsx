import type { ReactNode } from "react";

export default function Layout({
  children,
  alpha,
  beta,
}: {
  children: ReactNode;
  alpha: ReactNode;
  beta: ReactNode;
}) {
  return (
    <div>
      {alpha}
      {beta}
      {children}
    </div>
  );
}
