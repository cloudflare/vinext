"use client";

import { useState } from "react";
import { refreshFormState } from "./actions";

/**
 * Mirrors the Payload getFormState pattern: a blur-triggered server action
 * that returns form state without revalidating. Pending edits must survive
 * the roundtrip — the server tree must not be re-applied.
 */
export default function ActionFormPreservedForm() {
  const [actionResult, setActionResult] = useState<string | null>(null);

  async function handleBlur() {
    const result = await refreshFormState();
    setActionResult(`action returned ${result.fieldCount} fields`);
  }

  return (
    <div>
      <input id="edit-input" name="name" placeholder="Type something" onBlur={handleBlur} />
      <button id="blur-target" type="button">
        Move focus here
      </button>
      <p data-testid="action-result">{actionResult ?? "no action yet"}</p>
    </div>
  );
}
