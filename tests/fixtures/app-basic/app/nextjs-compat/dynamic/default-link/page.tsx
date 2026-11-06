import Link from "next/link";

export default function Page() {
  return (
    <div>
      <h1 id="default-link-title">Dynamic default link</h1>
      <Link href="/nextjs-compat/dynamic/default" id="to-dynamic-default">
        Go to dynamic default
      </Link>
    </div>
  );
}
