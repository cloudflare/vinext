import { createElement, useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return createElement(
    "button",
    {
      "data-testid": "client-barrel-counter",
      // Hydration can't match: the client loads the whole barrel.
      "data-unused-loaded": String(globalThis.__fakeClientBarrelUnusedLoaded === true),
      suppressHydrationWarning: true,
      onClick: () => setCount((value) => value + 1),
    },
    `Count: ${count}`,
  );
}
