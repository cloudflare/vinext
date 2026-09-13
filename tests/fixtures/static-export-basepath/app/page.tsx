import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <h1>BasePath Home</h1>
      <Link href="/about">About</Link>
    </main>
  );
}
