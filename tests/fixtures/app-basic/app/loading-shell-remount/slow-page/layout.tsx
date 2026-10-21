import Link from "next/link";
import type { ReactNode } from "react";

export default function FastLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <nav>
        <Link href="/loading-shell-remount/slow-page/a">A</Link>
        <Link href="/loading-shell-remount/slow-page/b">B</Link>
      </nav>
      {children}
    </div>
  );
}
