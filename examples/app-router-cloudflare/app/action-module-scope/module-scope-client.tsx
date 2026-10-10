"use client";

import { useActionState, useState } from "react";
import { readArgumentActionScope } from "./argument-actions";
import { callPassedAction, readFetchActionScope } from "./fetch-actions";
import { submitFormActionScope } from "./form-actions";

export function ModuleScopeClient() {
  const [fetchResult, setFetchResult] = useState("");
  const [argumentResult, setArgumentResult] = useState("");
  const [formResult, formAction] = useActionState(submitFormActionScope, null);

  return (
    <>
      <button
        data-testid="fetch-action"
        type="button"
        onClick={async () => setFetchResult(JSON.stringify(await readFetchActionScope()))}
      >
        Call action
      </button>
      <pre data-testid="fetch-result">{fetchResult}</pre>
      <button
        data-testid="argument-action"
        type="button"
        onClick={async () =>
          setArgumentResult(JSON.stringify(await callPassedAction(readArgumentActionScope)))
        }
      >
        Pass action as an argument
      </button>
      <pre data-testid="argument-result">{argumentResult}</pre>
      <form action={formAction}>
        <button data-testid="form-action" type="submit">
          Submit form
        </button>
      </form>
      <pre data-testid="form-result">{formResult}</pre>
    </>
  );
}
