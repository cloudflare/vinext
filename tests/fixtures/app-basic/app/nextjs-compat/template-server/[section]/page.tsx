import Link from "next/link";

export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const nextSection = section === "alpha" ? "beta" : "alpha";

  return (
    <>
      <p data-testid="server-template-section-page">Section {section}</p>
      <Link
        href={`/nextjs-compat/template-server/${section}?view=details`}
        data-testid="server-template-search-link"
      >
        Change search
      </Link>
      <Link
        href={`/nextjs-compat/template-server/${section}/child`}
        data-testid="server-template-child-link"
      >
        To child
      </Link>
      <Link
        href={`/nextjs-compat/template-server/${nextSection}`}
        data-testid="server-template-param-link"
      >
        Change section
      </Link>
    </>
  );
}
