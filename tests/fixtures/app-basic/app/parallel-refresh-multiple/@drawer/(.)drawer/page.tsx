import Link from "next/link";

export default function ParallelRefreshMultipleDrawer() {
  return (
    <aside data-testid="parallel-refresh-multiple-drawer">
      <p data-testid="parallel-refresh-multiple-drawer-token">{Math.random()}</p>
      <Link href="/parallel-refresh-multiple/modal">Open modal</Link>
    </aside>
  );
}
