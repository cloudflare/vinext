"use server";

import { redirect } from "next/navigation";

export async function delayedRedirectAction(): Promise<void> {
  redirect("/nextjs-compat/action-forwarded-redirect");
}

export async function delayedCrossRuntimeRedirectAction(): Promise<void> {
  redirect("/nextjs-compat/action-forwarded-redirect/node");
}
