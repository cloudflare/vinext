"use client";

import { notFound } from "next/navigation";
import { useState } from "react";

export default function Page() {
  const [triggered, setTriggered] = useState(false);

  if (triggered) {
    notFound();
  }

  return (
    <div>
      <h1 id="notfound-trigger-page">Not Found Trigger Page</h1>
      <button id="trigger-notfound" onClick={() => setTriggered(true)}>
        Trigger Not Found
      </button>
    </div>
  );
}
