import Link from "next/link";

export default function Page() {
  return (
    <>
      <p data-testid="server-template-page">Page</p>
      <Link href="/nextjs-compat/template-server/alpha" data-testid="server-template-link">
        To alpha
      </Link>
    </>
  );
}
