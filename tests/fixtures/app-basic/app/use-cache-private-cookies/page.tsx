import { cacheLife } from "next/cache";
import { cookies } from "next/headers";

async function PrivateCookie() {
  "use cache: private";

  cacheLife({ stale: 420 });
  const cookie = (await cookies()).get("test-cookie");

  return <span data-testid="test-cookie">{cookie?.value ?? "<empty>"}</span>;
}

export default function Page() {
  return (
    <p>
      test-cookie: <PrivateCookie />
    </p>
  );
}
