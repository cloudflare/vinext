"use client";

import { useActionState, type ReactNode } from "react";

export function Form({ action }: { action: () => Promise<ReactNode> }) {
  const [result, formAction] = useActionState(action, "initial");

  return (
    <form action={formAction}>
      <button>Submit</button>
      <p>{result}</p>
    </form>
  );
}
