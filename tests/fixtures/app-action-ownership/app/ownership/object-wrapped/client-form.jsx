"use client";

import { useActionState } from "react";
import { commands } from "./commands";

export function ClientForm() {
  const [result, formAction, pending] = useActionState(commands.objectWrappedAction, "");

  return (
    <form action={formAction}>
      <button data-testid="object-wrapped" disabled={pending} type="submit">
        Run object-wrapped action
      </button>
      <output data-testid="object-wrapped-result">{result}</output>
    </form>
  );
}
