"use client";

import { useActionState } from "react";
import { submitClientForm } from "../../barrels/client-form";

export function ClientForm() {
  const [result, formAction, pending] = useActionState(submitClientForm, "");

  return (
    <form action={formAction}>
      <input name="message" defaultValue="nested" />
      <button data-testid="client-form" disabled={pending} type="submit">
        submit
      </button>
      <output data-testid="client-form-result">{result}</output>
    </form>
  );
}
