"use client";

import { redirect } from "next/navigation";
import { startTransition, useState } from "react";

export default function Page() {
  const [triggered, setTriggered] = useState(false);

  if (triggered) {
    redirect("/nextjs-compat/nav-redirect-result");
  }

  return (
    <div>
      <h1 id="redirect-sentinel-page">Redirect Sentinel Page</h1>
      <button
        id="trigger-redirect"
        onClick={() => {
          startTransition(() => {
            setTriggered(true);
          });
        }}
        type="button"
      >
        Redirect
      </button>
    </div>
  );
}
