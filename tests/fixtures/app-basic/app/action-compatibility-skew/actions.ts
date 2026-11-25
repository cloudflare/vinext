"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function saveProfileAction(): Promise<{ ok: boolean }> {
  return { ok: true };
}

// Revalidating makes the server render the page tree into the response.
export async function saveAndRevalidateAction(): Promise<{ ok: boolean }> {
  revalidatePath("/action-compatibility-skew");
  return { ok: true };
}

export async function saveAndRedirectAction(): Promise<{ ok: boolean }> {
  redirect("/about");
}
