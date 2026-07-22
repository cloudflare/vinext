import Link from "next/link";

export const revalidate = 0;

export default function Page() {
  return (
    <>
      <h1 data-testid="soft-replace-render-id">{crypto.randomUUID()}</h1>
      <Link href="/nextjs-compat/link-soft-replace" replace data-testid="soft-replace-link">
        Refresh
      </Link>
    </>
  );
}
