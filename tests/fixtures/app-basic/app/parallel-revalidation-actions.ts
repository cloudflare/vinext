"use server";

import { revalidatePath } from "next/cache";

export async function revalidateParallelSlots(label?: string) {
  revalidatePath("/");
  return { label, success: true };
}
