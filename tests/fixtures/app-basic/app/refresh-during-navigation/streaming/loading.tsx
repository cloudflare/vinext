import Link from "next/link";

export default function Loading() {
  return (
    <>
      <Link href="/refresh-during-navigation" prefetch={false} data-testid="link-start">
        Start
      </Link>
      <p data-testid="stream-pending">Stream pending</p>
    </>
  );
}
