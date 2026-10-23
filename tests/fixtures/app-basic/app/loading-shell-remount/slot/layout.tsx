import Link from "next/link";
import type { ReactNode } from "react";

export default function FastLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <nav>
        <Link href="/loading-shell-remount/slot/a">A</Link>
        <Link href="/loading-shell-remount/slot/b">B</Link>
      </nav>
      {children}
    </div>
  );
}
