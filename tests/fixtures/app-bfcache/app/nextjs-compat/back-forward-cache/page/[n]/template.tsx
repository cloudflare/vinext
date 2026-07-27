"use client";

import { useState } from "react";
import { useParams } from "next/navigation";

export default function Template({ children }: { children: React.ReactNode }) {
  const { n } = useParams<{ n: string }>();
  const [count, setCount] = useState(0);

  return (
    <div>
      <button id={`template-increment-${n}`} onClick={() => setCount((value) => value + 1)}>
        Increment template
      </button>
      <span id={`template-counter-${n}`}>Template count: {count}</span>
      {children}
    </div>
  );
}
