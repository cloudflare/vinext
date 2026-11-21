"use server";

import { revalidatePath } from "next/cache";

export async function revalidateRooms() {
  revalidatePath("/bfcache-effects/rooms", "layout");
}
