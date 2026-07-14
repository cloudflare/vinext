"use client";

import { useActionState } from "react";
import { stateAction, unboundStateAction } from "../actions";

export function StateForm() {
  const [state, formAction] = useActionState(stateAction, { value: "initial" });

  return (
    <>
      <form action={formAction}>
        <p id="state-value">{state.value}</p>
        <input name="value" defaultValue="state-value" />
        <button type="submit">Update state</button>
      </form>
      <form action={unboundStateAction}>
        <button type="submit">Run unbound state action</button>
      </form>
    </>
  );
}
