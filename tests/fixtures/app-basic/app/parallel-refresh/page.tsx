import Link from "next/link";

export default function ParallelRefreshPage() {
  return (
    <main data-testid="parallel-refresh-page">
      <Link href="/parallel-refresh/login">Open login</Link>
      <p data-testid="parallel-refresh-page-token">{Math.random()}</p>
    </main>
  );
}
