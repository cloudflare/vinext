"use client";

import { useState } from "react";

export default function StyledJsxClientPage() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <p data-testid="styled-jsx-client">styled-jsx from a client component</p>
      <button data-testid="styled-jsx-client-increment" onClick={() => setCount((n) => n + 1)}>
        Count: {count}
      </button>
      <style jsx>{`
        p {
          color: purple;
        }
      `}</style>
    </div>
  );
}
