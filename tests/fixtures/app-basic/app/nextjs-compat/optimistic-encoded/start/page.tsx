import Link from "next/link";

export default function OptimisticEncodedStartPage() {
  return (
    <main>
      <p id="start-page">Start</p>
      <Link href="/nextjs-compat/optimistic-encoded/admin" prefetch={false} id="admin-link">
        Admin
      </Link>
    </main>
  );
}
