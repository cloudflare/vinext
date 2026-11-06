import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Static Assets Pages Router</h1>
      <p id="render-source">{process.env.VINEXT_PRERENDER === "1" ? "build-time" : "runtime"}</p>
      <Link href="/posts/first" prefetch={false}>
        First post
      </Link>
    </main>
  );
}
