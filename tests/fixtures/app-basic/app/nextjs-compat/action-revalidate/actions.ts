"use server";

import { revalidatePath } from "next/cache";

export async function revalidateAction() {
  revalidatePath("/nextjs-compat/action-revalidate");
}
