"use client";

import { useRouter } from "next/navigation";

export default function Page() {
  const router = useRouter();

  return (
    <div>
      <button id="back-button" onClick={() => router.back()}>
        Go Back
      </button>
    </div>
  );
}
