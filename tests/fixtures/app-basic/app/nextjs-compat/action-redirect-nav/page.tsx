import Link from "next/link";

export default function ActionNavHome() {
  return (
    <div>
      <h1 id="home">Action Navigation Home</h1>
      <Link href="/nextjs-compat/action-redirect-nav/action-after-redirect" id="go-to-action">
        Go to action page
      </Link>
    </div>
  );
}
