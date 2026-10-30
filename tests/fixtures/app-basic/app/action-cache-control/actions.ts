"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function setTheme(): Promise<void> {
  (await cookies()).set("theme", "dark");
}

export async function failAction(): Promise<void> {
  throw new Error("action-cache-control failure");
}

export async function redirectToConfigPolicy(): Promise<void> {
  redirect("/action-cache-control/config-policy");
}
