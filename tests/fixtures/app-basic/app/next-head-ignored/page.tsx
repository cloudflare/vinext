import Link from "next/link";

export default function NextHeadIgnoredPage() {
  return (
    <main>
      <h1>next/head in the App Router</h1>
      <Link href="/next-head-ignored/server-component" id="next-head-server-link">
        Server component
      </Link>
    </main>
  );
}
