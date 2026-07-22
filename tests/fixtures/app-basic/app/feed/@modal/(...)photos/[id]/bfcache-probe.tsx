"use client";

import { useRouter } from "next/navigation";

export function PhotoModalBfcacheProbe() {
  const router = useRouter();

  return (
    <>
      <p data-testid="photo-modal-bfcache-id">{router.bfcacheId}</p>
      <form key={router.bfcacheId}>
        <input data-testid="photo-modal-input" defaultValue="" />
      </form>
    </>
  );
}
