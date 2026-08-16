import Link from "next/link";

export default function Page() {
  return (
    <Link prefetch={false} href="/nextjs-compat/rsc-query-routing/redirect/source">
      Redirect Link
    </Link>
  );
}
