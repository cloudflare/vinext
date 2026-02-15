import { useState } from "react";

export default function ClientOnlyComponent() {
  const [count, setCount] = useState(0);
  return (
    <div data-testid="client-only">
      <p>I am a client-only component</p>
      <button data-testid="client-counter" onClick={() => setCount(count + 1)}>
        Count: {count}
      </button>
    </div>
  );
}
