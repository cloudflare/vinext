"use client";

import { useActionState } from "react";

// Ported from Next.js: test/e2e/app-dir/use-cache-with-server-function-props
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache-with-server-function-props/app/nested-cache/form.tsx

export function Form({
  getDate,
  getRandom,
  getMessage,
  idSuffix,
}: {
  getDate: () => Promise<string>;
  getRandom: () => Promise<number>;
  // Closure-capturing cached function — exercises bound-arg serialization.
  getMessage: () => Promise<string>;
  idSuffix?: string;
}) {
  const suffix = idSuffix ? `-${idSuffix}` : "";
  const [date, formAction, isDatePending] = useActionState(getDate, null);

  const [random, buttonAction, isRandomPending] = useActionState(getRandom, null);

  const [message, messageAction, isMessagePending] = useActionState(getMessage, null);

  return (
    <form action={formAction}>
      <button id={`submit-button-date${suffix}`}>Get Date</button>{" "}
      <button id={`submit-button-random${suffix}`} formAction={buttonAction}>
        Get Random
      </button>{" "}
      <button id={`submit-button-message${suffix}`} formAction={messageAction}>
        Get Message
      </button>
      <p id={`date${suffix}`}>{isDatePending ? "loading..." : date}</p>
      <p id={`random${suffix}`}>{isRandomPending ? "loading..." : random}</p>
      <p id={`message${suffix}`}>{isMessagePending ? "loading..." : message}</p>
    </form>
  );
}
