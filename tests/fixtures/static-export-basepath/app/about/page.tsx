import Link from "next/link";

export default function AboutPage() {
  return (
    <main>
      <h1>BasePath About</h1>
      <Link href="/about">About</Link>
      <Link href="/">Home</Link>
    </main>
  );
}
