import Link from "next/link";

export default function Page() {
  return (
    <>
      <p data-testid="server-template-other-page">Other page</p>
      <Link href="/nextjs-compat/template-server" data-testid="server-template-link">
        To page
      </Link>
    </>
  );
}
