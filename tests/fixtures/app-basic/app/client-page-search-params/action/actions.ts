"use server";

import { revalidatePath } from "next/cache";

export async function refreshClientPageSearchParams() {
  revalidatePath("/client-page-search-params/action");
}
