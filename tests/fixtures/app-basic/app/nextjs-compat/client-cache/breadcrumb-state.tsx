"use client";

import { useState } from "react";

export function BreadcrumbState() {
  const [count, setCount] = useState(0);

  return (
    <button
      aria-label="Increment breadcrumb count"
      data-count={count}
      id="client-cache-breadcrumb-count"
      type="button"
      onClick={() => setCount((value) => value + 1)}
    />
  );
}
