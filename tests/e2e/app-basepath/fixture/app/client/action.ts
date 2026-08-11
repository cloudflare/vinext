"use server";

import "server-only";

import { redirect } from "next/navigation";

export async function redirectAction(path: string) {
  redirect(path);
}
