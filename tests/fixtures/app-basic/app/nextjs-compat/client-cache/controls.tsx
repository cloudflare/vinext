"use client";

import { useRouter } from "next/navigation";
import { revalidateClientCacheAction } from "./actions";

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
    </>
  );
}
