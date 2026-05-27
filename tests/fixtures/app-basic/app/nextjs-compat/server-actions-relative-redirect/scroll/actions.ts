"use server";

import { redirect } from "next/navigation";

export async function redirectToReceipt() {
  redirect("../receipt");
}
