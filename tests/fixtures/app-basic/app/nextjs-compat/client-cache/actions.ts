"use server";

import { revalidatePath } from "next/cache";

export async function revalidateClientCacheAction() {
  revalidatePath("/nextjs-compat/client-cache");
}
