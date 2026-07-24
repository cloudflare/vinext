import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ParallelRefreshDynamicLayout({
  children,
  modal,
  params,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <div data-testid="parallel-refresh-dynamic-layout">
      <div>{children}</div>
      <div>{modal}</div>
      <Link href={`/parallel-refresh-dynamic/${slug}/other?source=other`}>Other dynamic page</Link>
    </div>
  );
}
