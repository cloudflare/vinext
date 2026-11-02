"use client";

import { useEffect, useState } from "react";
import badgeUrl from "./badge.svg?url";

export function Badge() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return <img id="js-badge" alt="badge" src={badgeUrl} data-hydrated={hydrated} />;
}
