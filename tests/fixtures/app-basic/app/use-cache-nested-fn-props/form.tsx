"use client";

import { useActionState } from "react";

// Ported from Next.js: test/e2e/app-dir/use-cache-with-server-function-props
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache-with-server-function-props/app/nested-cache/form.tsx

export function Form({
  getDate,
  getRandom,
  getMessage,
}: {
  getDate: () => Promise<string>;
  getRandom: () => Promise<number>;
  // Closure-capturing cached function — exercises bound-arg serialization
  // (the captured value travels as an unencrypted `.bind(null, ...)` arg).
  getMessage: () => Promise<string>;
}) {
  const [date, formAction, isDatePending] = useActionState(getDate, null);

  const [random, buttonAction, isRandomPending] = useActionState(getRandom, null);

  const [message, messageAction, isMessagePending] = useActionState(getMessage, null);

  return (
    <form action={formAction}>
      <button id="submit-button-date">Get Date</button>{" "}
      <button id="submit-button-random" formAction={buttonAction}>
        Get Random
      </button>{" "}
      <button id="submit-button-message" formAction={messageAction}>
        Get Message
      </button>
      <p id="date">{isDatePending ? "loading..." : date}</p>
      <p id="random">{isRandomPending ? "loading..." : random}</p>
      <p id="message">{isMessagePending ? "loading..." : message}</p>
    </form>
  );
}
