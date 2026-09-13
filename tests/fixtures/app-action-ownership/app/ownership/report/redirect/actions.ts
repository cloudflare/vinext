"use server";

import { redirect } from "next/navigation";

export async function redirectTo(target: string) {
  redirect(target);
}
