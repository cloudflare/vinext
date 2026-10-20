"use client";

import "./first.css";

// Loads slower than its sibling, so a render that loaded client references as
// the Flight stream named them would link the two stylesheets in load order.
if (typeof window === "undefined") {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

export function First() {
  return <p data-testid="first">first</p>;
}
