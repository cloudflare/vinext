"use client";

import { useState } from "react";

import "./widget.css";

export default function Widget() {
  const [count, setCount] = useState(0);
  return (
    <button data-testid="dynamic-widget" onClick={() => setCount(count + 1)}>
      dynamic {count}
    </button>
  );
}
