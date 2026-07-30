import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Home</h1>
      <Link href="/about">About</Link>
      <Link href="/isr-basepath">ISR</Link>
      <Link href="#some-hash">Hash</Link>
      <Link href="/slow-route">Slow route</Link>
      <Link href="/error-route">Error route</Link>
    </main>
  );
}
