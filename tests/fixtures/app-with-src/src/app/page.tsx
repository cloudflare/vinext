import Link from "next/link";

export default function HomePage() {
  return (
    <>
      <h1 id="app-with-src-home">App With Src</h1>
      <Link href="/dev-overlay-recovery" data-testid="link-to-recovery">
        Recovery
      </Link>
    </>
  );
}
