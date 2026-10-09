"use server";

import { cookies } from "next/headers";

export async function refreshPhoto() {
  // A cookie mutation makes the action rerender the page.
  (await cookies()).set("photo-refreshed", "1");
}
