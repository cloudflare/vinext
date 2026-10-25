"use client";

import { useRouter } from "next/navigation";

export function SignOut({ cookie }: { cookie: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => {
        document.cookie = `${cookie}=1; path=/`;
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
