"use client";

import "./slow.css";

if (typeof window === "undefined") {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

export function Slow() {
  return <p className="css-group-slow-first">slow</p>;
}
