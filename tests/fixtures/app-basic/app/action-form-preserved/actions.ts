"use server";

/**
 * Data-returning server action that performs no revalidation — the same
 * shape as Payload's getFormState. Next.js resolves the action value without
 * touching the React tree (see server-action-reducer bail-out); the e2e
 * verifies vinext matches so pending form edits survive.
 */
export async function refreshFormState(): Promise<{ fieldCount: number }> {
  return { fieldCount: 3 };
}
