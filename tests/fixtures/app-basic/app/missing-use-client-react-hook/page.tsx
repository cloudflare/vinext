/**
 * Reproduces https://github.com/cloudflare/vinext/issues/834 for React hooks.
 *
 * This is a SERVER component (no "use client" directive) that calls
 * useState() from react. It should throw a clear error telling the
 * developer to add "use client", not a cryptic "is not a function".
 */
import { useState } from "react";

export default function MissingUseClientReactHookPage() {
  const [count] = useState(0);

  return (
    <div>
      <h1>Missing use client react hook test</h1>
      <p>Count: {count}</p>
    </div>
  );
}
