import Link from "next/link";

export default function Page() {
  return (
    <Link prefetch={false} href="/nextjs-compat/rsc-query-rewrite/source">
      Rewrite Link
    </Link>
  );
}
