import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Home</h1>
      <Link href="/about">About</Link>
      <Link href="/isr-basepath">ISR</Link>
    </main>
  );
}
