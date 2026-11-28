import type { ReactNode } from "react";

export default function Layout({ children, team }: { children: ReactNode; team: ReactNode }) {
  return (
    <div>
      {team}
      {children}
    </div>
  );
}
