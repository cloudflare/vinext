import Link from "next/link";

export const dynamic = "force-dynamic";

export default function ParallelRefreshMultipleLayout({
  children,
  drawer,
  modal,
}: {
  children: React.ReactNode;
  drawer: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div data-testid="parallel-refresh-multiple-layout">
      <div>{children}</div>
      <div>{drawer}</div>
      <div>{modal}</div>
      <Link href="/parallel-refresh-multiple/other">Multiple other page</Link>
    </div>
  );
}
