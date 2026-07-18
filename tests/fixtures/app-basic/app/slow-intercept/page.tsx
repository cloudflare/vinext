import Link from "next/link";

export default function SlowInterceptPage() {
  return (
    <Link href="/slow-intercept/photo" data-testid="slow-intercept-link">
      Open slow photo
    </Link>
  );
}
