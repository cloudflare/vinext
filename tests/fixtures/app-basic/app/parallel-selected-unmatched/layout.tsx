"use client";

import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";

export default function Layout({
  children,
  status,
}: {
  children: React.ReactNode;
  status: React.ReactNode;
}) {
  const statusSegment = useSelectedLayoutSegment("status");

  return (
    <main>
      <nav>
        <Link href="/parallel-selected-unmatched/target/ready">Open Status</Link>
        <Link href="/parallel-selected-unmatched/foo">Foo</Link>
      </nav>
      <div id="statusSegment">status segment: {statusSegment}</div>
      <section id="statusSlot">{status}</section>
      <section id="children">{children}</section>
    </main>
  );
}
