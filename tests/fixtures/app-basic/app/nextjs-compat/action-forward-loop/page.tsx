"use client";

import { useActionState } from "react";
import { runAction } from "./actions";

export default function Page() {
  const [result, formAction] = useActionState(runAction, "");

  return (
    <main>
      <h1 id="action-forward-loop-page">Action Forward Loop Test</h1>
      <form action={formAction}>
        <button id="run-action" type="submit">
          Run action
        </button>
      </form>
      <p id="action-result">{result}</p>
    </main>
  );
}
