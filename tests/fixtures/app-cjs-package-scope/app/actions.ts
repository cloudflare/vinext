"use server";

import { redirect } from "next/navigation";

export async function exportedAction() {
  redirect("/?action=exported");
}
