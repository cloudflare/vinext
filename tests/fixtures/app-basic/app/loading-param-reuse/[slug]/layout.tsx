import Link from "next/link";
import type { ReactNode } from "react";

export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  return (
    <section>
      <nav>
        <Link href="/loading-param-reuse/first" data-testid="loading-param-first-link">
          First
        </Link>
        <Link href="/loading-param-reuse/second" data-testid="loading-param-second-link">
          Second
        </Link>
      </nav>
      <p data-testid="loading-param-layout-slug">Layout slug: {slug}</p>
      {children}
    </section>
  );
}
