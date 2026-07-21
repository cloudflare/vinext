import Link from "next/link";

export default function Page() {
  return (
    <>
      <p data-testid="client-template-page">Page</p>
      <Link href="/nextjs-compat/template-client/other" data-testid="client-template-link">
        To other
      </Link>
    </>
  );
}
