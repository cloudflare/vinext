"use server";

import { refresh, revalidatePath } from "next/cache";

export async function revalidateClientCacheAction() {
  revalidatePath("/nextjs-compat/client-cache");
}

export async function refreshClientCacheAction() {
  refresh();
}
