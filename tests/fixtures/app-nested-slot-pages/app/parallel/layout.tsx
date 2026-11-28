import type { ReactNode } from "react";

export default function Layout({ children, foo }: { children: ReactNode; foo: ReactNode }) {
  return (
    <div>
      {foo}
      {children}
    </div>
  );
}
