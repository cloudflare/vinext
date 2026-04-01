"use client";

import { useActionState } from "react";
import { redirectToSelf } from "../actions/actions";

export default function ActionSelfRedirect() {
  const [state, formAction] = useActionState(redirectToSelf, {
    success: false,
    error: undefined,
  });

  return (
    <div>
      <h1>Action Self-Redirect Test</h1>
      <p>
        This form redirects back to the same page. After submission, the form state should reset to
        initial state (success: false).
      </p>
      <form action={formAction}>
        <input type="hidden" name="redirect" value="true" />
        <button type="submit" data-testid="submit-btn">
          Submit and Redirect to Same Page
        </button>
      </form>
      <div data-testid="state">{JSON.stringify(state)}</div>
      {state.error && <p data-testid="error">{state.error}</p>}
    </div>
  );
}
