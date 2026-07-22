"use client";

import { useRouter } from "next/navigation";

export function HashActions() {
  const router = useRouter();

  return (
    <>
      <button id="replace-top" onClick={() => router.replace("#top")} type="button">
        Replace top
      </button>
      <button id="replace-content" onClick={() => router.replace("#content")} type="button">
        Replace content
      </button>
    </>
  );
}
