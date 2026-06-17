import Link from "next/link";

export default function Page() {
  return (
    <>
      <h1 id="render-id">{Math.random().toString(36).slice(2)}</h1>
      <Link href="/navigation" id="link">
        To Navigation
      </Link>
    </>
  );
}
