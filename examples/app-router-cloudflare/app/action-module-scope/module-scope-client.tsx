"use client";

import { useActionState, useState } from "react";
import { readArgumentActionScope } from "./argument-actions";
import { callAwaitedAction, callPassedAction, readFetchActionScope } from "./fetch-actions";
import { submitFormActionScope } from "./form-actions";
import { readPromiseActionScope } from "./promise-actions";

export function ModuleScopeClient() {
  const [fetchResult, setFetchResult] = useState("");
  const [argumentResult, setArgumentResult] = useState("");
  const [promiseResult, setPromiseResult] = useState("");
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
      <button
        data-testid="promise-action"
        type="button"
        onClick={async () =>
          setPromiseResult(
            JSON.stringify(await callAwaitedAction(Promise.resolve(readPromiseActionScope))),
          )
        }
      >
        Pass action inside a promise argument
      </button>
      <pre data-testid="promise-result">{promiseResult}</pre>
      <form action={formAction}>
        <button data-testid="form-action" type="submit">
          Submit form
        </button>
      </form>
      <pre data-testid="form-result">{formResult}</pre>
    </>
  );
}
