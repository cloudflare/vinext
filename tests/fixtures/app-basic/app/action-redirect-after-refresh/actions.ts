"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// Revalidates this page so its refresh commits while redirectAction is pending.
export async function saveAction(): Promise<void> {
  revalidatePath("/action-redirect-after-refresh");
}

export async function redirectAction(): Promise<void> {
  redirect("/about");
}
