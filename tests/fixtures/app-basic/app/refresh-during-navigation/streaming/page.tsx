import Link from "next/link";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

async function SlowContent() {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  return <p>Stream complete</p>;
}

export default function StreamingPage() {
  return (
    <>
      <Link href="/refresh-during-navigation" prefetch={false} data-testid="link-start">
        Start
      </Link>
      <Suspense fallback={<p data-testid="stream-pending">Stream pending</p>}>
        <SlowContent />
      </Suspense>
    </>
  );
}
