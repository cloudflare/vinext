import Link from "next/link";

export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const nextSection = section === "alpha" ? "beta" : "alpha";

  return (
    <>
      <p data-testid="server-template-child-page">Child {section}</p>
      <Link
        href={`/nextjs-compat/template-server/${nextSection}`}
        data-testid="server-template-param-link"
      >
        Change section
      </Link>
    </>
  );
}
