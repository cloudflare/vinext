"use client";

import { useActionState } from "react";
import { redirectWithActionState } from "../actions/actions";

const initialState = { success: false, error: undefined as string | undefined };

export default function ActionStateRedirectTest() {
  const [state, formAction] = useActionState(redirectWithActionState, initialState);

  return (
    <div>
      <h1>useActionState Redirect Test</h1>
      <div id="state">{JSON.stringify(state)}</div>
      <form action={formAction}>
        <button type="submit" name="redirect" value="true" id="redirect-btn">
          Submit and Redirect
        </button>
      </form>
    </div>
  );
}
