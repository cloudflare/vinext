import Link from "next/link";

export default function Page() {
  return (
    <>
      <p data-testid="server-template-page">Page</p>
      <Link href="/nextjs-compat/template-server/other" data-testid="server-template-link">
        To other
      </Link>
    </>
  );
}
