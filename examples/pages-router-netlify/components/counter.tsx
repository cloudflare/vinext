import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <p>Count: <span id="count">{count}</span></p>
      <button id="increment" onClick={() => setCount(count + 1)}>+</button>
    </div>
  );
}
