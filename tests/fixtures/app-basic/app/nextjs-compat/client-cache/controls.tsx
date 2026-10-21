"use client";

import { useRouter } from "next/navigation";
import { refreshClientCacheAction, revalidateClientCacheAction } from "./actions";

export function ClientCacheControls() {
  const router = useRouter();

  return (
    <>
      <button id="client-cache-invalidate" type="button" onClick={() => router.refresh()}>
        Invalidate client cache
      </button>
      <form action={revalidateClientCacheAction}>
        <button id="client-cache-revalidate-action" type="submit">
          Revalidate with a Server Action
        </button>
      </form>
      <form action={refreshClientCacheAction}>
        <button id="client-cache-refresh-action" type="submit">
          Refresh dynamic data with a Server Action
        </button>
      </form>
    </>
  );
}
