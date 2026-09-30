"use server";

import { redirect } from "next/navigation";

export async function redirectToStart() {
  redirect("/refresh-during-navigation");
}
