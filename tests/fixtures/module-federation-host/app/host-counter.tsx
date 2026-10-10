"use client";

import { useState } from "react";

export function HostCounter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount((value) => value + 1)}>Host counter: {count}</button>;
}
