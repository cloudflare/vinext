"use server";

import { revalidatePath } from "next/cache";

export async function revalidateTemplateSeed() {
  revalidatePath("/nextjs-compat/back-forward-cache/template-seed", "layout");
}
