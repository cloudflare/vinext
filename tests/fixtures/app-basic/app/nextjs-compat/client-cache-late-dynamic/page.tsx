import Link from "next/link";
import { cookies } from "next/headers";

export const unstable_dynamicStaleTime = 60;

async function LateDynamicContent() {
  // Keep the request API below the page component so the page probe initially
  // treats this route as cacheable; React discovers the dynamic read only while
  // consuming the RSC stream.
  await new Promise((resolve) => setTimeout(resolve, 25));
  await cookies();
  return <div id="client-cache-late-dynamic-random">{Math.random()}</div>;
}

export default function ClientCacheLateDynamicTarget() {
  return (
    <main>
      <Link
        href="/nextjs-compat/client-cache-late-dynamic-return"
        prefetch={false}
        id="client-cache-late-dynamic-back"
      >
        Back to client cache home
      </Link>
      <LateDynamicContent />
    </main>
  );
}
