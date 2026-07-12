"use server";

import { revalidatePath, revalidateTag } from "next/cache";

export async function revalidateAction() {
  revalidatePath("/nextjs-compat/action-revalidate");
}

export async function revalidateTagAction() {
  revalidateTag("action-revalidate-layout");
}
