"use server";

import { redirect } from "next/navigation";

export async function relativeRedirect() {
  redirect("./subpage");
}

export async function multiRelativeRedirect() {
  redirect("../subpage");
}

export async function absoluteRedirect() {
  redirect("/nextjs-compat/server-actions-relative-redirect/subpage");
}
