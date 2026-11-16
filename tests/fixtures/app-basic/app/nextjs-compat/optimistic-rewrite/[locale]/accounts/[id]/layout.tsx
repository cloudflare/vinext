import Link from "next/link";

export default async function AccountLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section>
      <nav id="account-tabs">
        <Link href={`/nextjs-compat/optimistic-rewrite/accounts/${id}`} prefetch={false}>
          Overview
        </Link>
        <Link
          href={`/nextjs-compat/optimistic-rewrite/accounts/${id}/activity`}
          prefetch={false}
          id="activity-link"
        >
          Activity
        </Link>
      </nav>
      {children}
    </section>
  );
}
