"use client";

import { saveAndRedirectAction, saveAndRevalidateAction, saveProfileAction } from "./actions";

export const RESULT_STORAGE_KEY = "action-compatibility-skew-result";

// The outcome goes to sessionStorage because a response from another
// deployment reloads the page right after the action settles.
async function run(action: () => Promise<{ ok: boolean }>) {
  sessionStorage.removeItem(RESULT_STORAGE_KEY);
  try {
    const result = await action();
    sessionStorage.setItem(RESULT_STORAGE_KEY, `resolved:${String(result.ok)}`);
  } catch (error) {
    const digest = (error as { digest?: unknown } | null)?.digest;
    sessionStorage.setItem(
      RESULT_STORAGE_KEY,
      typeof digest === "string" ? `rejected:${digest}` : `rejected:${String(error)}`,
    );
  }
}

export function SaveTriggers() {
  return (
    <div>
      <button id="save" onClick={() => run(saveProfileAction)}>
        Save
      </button>
      <button id="save-revalidate" onClick={() => run(saveAndRevalidateAction)}>
        Save and revalidate
      </button>
      <button id="save-redirect" onClick={() => run(saveAndRedirectAction)}>
        Save and redirect
      </button>
    </div>
  );
}
