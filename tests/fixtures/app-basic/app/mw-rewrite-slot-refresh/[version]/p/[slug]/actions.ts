"use server";

import { revalidatePath } from "next/cache";

export async function revalidateRewrittenPage(): Promise<void> {
  revalidatePath("/");
}
