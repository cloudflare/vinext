"use client";

import { useRouter } from "next/navigation";

export default function Page() {
  const router = useRouter();

  return (
    <>
      <h1 id="dummy-page-2">Dummy Page 2</h1>
      <button
        id="go-home"
        onClick={() => router.replace("/nextjs-compat/stale-search-params-on-replace-regression")}
      >
        Go to home
      </button>
    </>
  );
}
