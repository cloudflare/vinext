"use client";

import React, { Suspense, useState } from "react";
import { redirect } from "next/navigation";
import { SearchMarker } from "./search-marker";

export default function Root({ children }: { children: React.ReactNode }) {
  const [clicked, setClicked] = useState(false);
  if (clicked) {
    redirect("/result");
  }

  return (
    <html>
      <body>
        <button id="trigger-redirect" onClick={() => setClicked(true)}>
          Click to redirect
        </button>
        <Suspense>
          <SearchMarker />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
