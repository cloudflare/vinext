import Link from "next/link";

export default function Page() {
  return (
    <>
      <Link id="link-to-slot-redirect" href="/nextjs-compat/slot-redirect/go">
        slot redirect
      </Link>
      <Link id="link-to-slot-not-found" href="/nextjs-compat/slot-not-found">
        slot not found
      </Link>
    </>
  );
}
