"use client";

import { useRouter } from "next/navigation";

export function SignOut() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => {
        document.cookie = "mpa-fallback-signed-out=1; path=/";
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
