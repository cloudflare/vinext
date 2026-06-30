import Link from "next/link";

export default function Page() {
  return (
    <>
      <p data-testid="client-template-other-page">Other page</p>
      <Link href="/nextjs-compat/template-client" data-testid="client-template-link">
        To page
      </Link>
    </>
  );
}
