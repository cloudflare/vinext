"use server";

import { revalidatePath } from "next/cache";

export async function revalidateInterceptedPhoto(): Promise<number> {
  revalidatePath("/dynamic-interception-revalidate/en/photos/1/view");
  return 0;
}
