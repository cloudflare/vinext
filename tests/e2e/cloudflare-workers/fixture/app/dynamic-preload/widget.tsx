"use client";

import { useState } from "react";
import "./widget.css";

export default function DynamicWidget() {
  const [count, setCount] = useState(0);
  return (
    <button data-testid="dynamic-count" onClick={() => setCount((value) => value + 1)}>
      Dynamic count: {count}
    </button>
  );
}
