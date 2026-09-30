"use server";

import { refresh, revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { incrementValue } from "./state";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function slowAction(): Promise<number> {
  await wait(800);
  return incrementValue();
}

export async function slowActionWithRefresh(): Promise<number> {
  await wait(800);
  const value = incrementValue();
  refresh();
  return value;
}

export async function revalidatingRedirect(
  target = "/nextjs-compat/action-discarding",
): Promise<never> {
  incrementValue();
  revalidatePath("/nextjs-compat/action-discarding", "layout");
  redirect(target);
}
