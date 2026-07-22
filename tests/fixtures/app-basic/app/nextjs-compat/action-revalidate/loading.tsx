"use client";

import { useEffect } from "react";

export default function Loading() {
  useEffect(() => {
    console.log("Action revalidate loading mounted");
  }, []);

  return <p id="action-revalidate-loading">Loading...</p>;
}
