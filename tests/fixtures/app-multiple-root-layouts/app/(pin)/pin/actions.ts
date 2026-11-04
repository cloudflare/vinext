"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function submitPin(formData: FormData) {
  (await cookies()).set("pin", String(formData.get("pin")), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  redirect("/");
}
