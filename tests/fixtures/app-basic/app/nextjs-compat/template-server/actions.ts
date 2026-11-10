"use server";

import { revalidatePath } from "next/cache";

export async function revalidateTemplateServer() {
  revalidatePath("/nextjs-compat/template-server", "layout");
}
