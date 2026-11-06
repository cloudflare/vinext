import Link from "next/link";

// Links to pages whose server component calls redirect() or notFound().
export default function Page() {
  return (
    <nav>
      <h1 id="special-error-links-page">Special Error Links</h1>
      <Link href="/nextjs-compat/nav-redirect-server" id="link-to-redirect-page">
        Go to redirect() Page
      </Link>
      <Link href="/notfound-test" id="link-to-notfound-page">
        Go to notFound() Page
      </Link>
    </nav>
  );
}
