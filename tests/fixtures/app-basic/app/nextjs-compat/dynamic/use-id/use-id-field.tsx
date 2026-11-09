"use client";

import { useEffect, useId, useState } from "react";

export default function UseIdField() {
  const id = useId();
  const [hydrated, setHydrated] = useState(false);
  // oxlint-disable-next-line react/set-state-in-effect -- marks the hydrated render
  useEffect(() => setHydrated(true), []);
  return (
    <p id="dynamic-use-id" data-hydrated={hydrated ? "" : undefined}>
      <label htmlFor={id}>Name</label>
      <input id={id} />
      <span id="dynamic-use-id-value">{id}</span>
    </p>
  );
}
