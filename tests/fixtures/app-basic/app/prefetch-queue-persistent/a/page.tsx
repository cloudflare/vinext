import Link from "next/link";

export default function PrefetchQueuePersistentA() {
  return (
    <main>
      <h1>Page A</h1>
      <Link id="go-to-b" href="/prefetch-queue-persistent/b" prefetch={false}>
        Go to B
      </Link>
    </main>
  );
}
