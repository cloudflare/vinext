import Link from "next/link";

export default function Home() {
  return (
    <div id="home">
      <h1>Home</h1>
      {/* Not prefetched, so the navigation itself has to reach the network. */}
      <Link href="/destination" prefetch={false}>
        Destination page
      </Link>
    </div>
  );
}
