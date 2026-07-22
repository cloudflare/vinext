"use server";

import { notFound, redirect } from "next/navigation";

export async function completeAction(): Promise<string> {
  return "complete";
}

export async function redirectToAbout(): Promise<void> {
  redirect("/about");
}

export async function missingAction(): Promise<void> {
  notFound();
}
