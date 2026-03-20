"use client";

import { useState } from "react";

export default function Dynamic({ name }: { name?: string }) {
  const [state] = useState("dynamic no ssr on client" + (name || ""));
  return <p id="css-text-dynamic-no-ssr-client">{`next-dynamic ${state}`}</p>;
}
