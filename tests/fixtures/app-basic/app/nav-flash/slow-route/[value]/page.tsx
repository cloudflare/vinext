// Slow route fixture for testing cancelled navigation param leak
// This route intentionally delays rendering to allow test to supersede it

import Link from "next/link";

export default async function SlowRoutePage({ params }: { params: Promise<{ value: string }> }) {
  const { value } = await params;

  // Intentional delay to simulate slow RSC fetch
  // This allows tests to supersede this navigation before it completes
  await new Promise((resolve) => setTimeout(resolve, 500));

  return (
    <div>
      <h1 id="slow-title">Slow Route</h1>
      <p id="slow-param">Param: {value}</p>
      <Link href="/nav-flash/slow-route/superseded-value" id="link-superseded">
        Navigate to Superseded Value
      </Link>
      <Link href="/nav-flash/list" id="link-list">
        Go to List (will cancel slow nav)
      </Link>
      <Link href="/nav-flash/param-sync/active" id="to-param-sync">
        Go to Param Sync
      </Link>
    </div>
  );
}
