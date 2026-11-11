import Link from "next/link";

export default function NotFound() {
  return (
    <main>
      <h1>404</h1>
      <p>This page could not be found.</p>
      <Link href="/">Home</Link>
    </main>
  );
}
