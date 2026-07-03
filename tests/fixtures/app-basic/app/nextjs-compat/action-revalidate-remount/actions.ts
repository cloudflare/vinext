"use server";

import { revalidatePath } from "next/cache";

export async function touchAction(): Promise<void> {
  // Revalidating the current path re-renders the segment. The remount bug also
  // fired for unrelated paths, but revalidating the current path is the common
  // "mutate but stay on the page" case and re-renders deterministically.
  revalidatePath("/nextjs-compat/action-revalidate-remount");
}
