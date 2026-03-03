"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addEntry } from "./_guestbook.js";

export async function addGuestbookEntry(formData: FormData): Promise<void> {
  const name = formData.get("name") as string;
  if (name?.trim()) {
    addEntry(name.trim());
    revalidatePath("/about");
  }
}

export async function redirectToHome(): Promise<never> {
  redirect("/");
}
