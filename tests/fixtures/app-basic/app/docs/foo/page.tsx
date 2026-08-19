import Link from "next/link";

export const revalidate = 0;

export default function Page() {
  return (
    <>
      <h1 data-testid="prefix-collision-render-id">{crypto.randomUUID()}</h1>
      <Link href="/docs/foo" replace prefetch={false} data-testid="prefix-collision-link">
        Refresh
      </Link>
    </>
  );
}
