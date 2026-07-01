import Link from "next/link";

export default function Page() {
  return (
    <main>
      <h1>Inherited loading prefetch navigation</h1>
      <Link id="inherited-loading-link" href="/slow-layout-with-loading/slow">
        Open slow nested layout
      </Link>
    </main>
  );
}
