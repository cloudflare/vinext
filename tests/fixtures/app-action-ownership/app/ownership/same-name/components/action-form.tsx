"use client";

import { useActionState } from "react";
import { submit } from "../action";

export function ActionForm() {
  const [result, formAction, pending] = useActionState(submit, "");

  return (
    <form action={formAction}>
      <input name="message" defaultValue="distinct" />
      <button data-testid="same-name-action" disabled={pending} type="submit">
        submit action
      </button>
      <output data-testid="same-name-action-result">{result}</output>
    </form>
  );
}
