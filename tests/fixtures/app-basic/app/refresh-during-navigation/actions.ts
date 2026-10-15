"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function redirectToTarget() {
  redirect("/refresh-during-navigation/redirect-target");
}

export async function revalidateStart() {
  revalidatePath("/refresh-during-navigation");
}
