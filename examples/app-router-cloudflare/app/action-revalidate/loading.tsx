"use client";

import { useEffect } from "react";

export default function Loading() {
  useEffect(() => {
    console.log("Action revalidate loading mounted");
  }, []);

  return <p data-testid="action-revalidate-loading">Loading...</p>;
}
