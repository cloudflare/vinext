"use server";

import { refresh } from "next/cache";

export async function refreshAction() {
  refresh();
}

export async function returnValueOnlyAction() {
  return "return-value-only";
}
