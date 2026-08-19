import Link from "next/link";

export default function Page() {
  return (
    <Link href="/nextjs-compat/link-soft-target" data-testid="soft-push-link">
      Target
    </Link>
  );
}
