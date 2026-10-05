import Link from "next/link";

// One link per page, so one link's prefetch can't serve another's navigation.
export default async function Page({ params }: { params: Promise<{ mode: string }> }) {
  const { mode } = await params;
  return (
    <nav>
      <h1 id="links-page">links: {mode}</h1>
      {mode === "prefetch" && (
        <Link href="/nextjs-compat/isr-special-error/link-target" id="link">
          Stored notFound() page
        </Link>
      )}
      {mode === "no-prefetch" && (
        <Link href="/nextjs-compat/isr-special-error/link-target" id="link" prefetch={false}>
          Stored notFound() page without prefetch
        </Link>
      )}
      {mode === "full-prefetch" && (
        <Link href="/nextjs-compat/isr-special-error/link-target" id="link" prefetch={true}>
          Stored notFound() page with a full prefetch
        </Link>
      )}
      {mode === "missing" && (
        <Link href="/nextjs-compat/isr-special-error/does-not-exist" id="link">
          Unmatched route
        </Link>
      )}
    </nav>
  );
}
