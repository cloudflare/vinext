import Link from "next/link";

export const dynamic = "force-dynamic";

export default function ParallelRefreshLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div data-testid="parallel-refresh-layout">
      <div data-testid="parallel-refresh-children">{children}</div>
      <div data-testid="parallel-refresh-modal-slot">{modal}</div>
      <Link href="/parallel-refresh/other">Other page</Link>
    </div>
  );
}
