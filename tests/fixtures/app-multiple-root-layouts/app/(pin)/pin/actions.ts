"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function submitPin(formData: FormData) {
  if (formData.get("pin") !== "9999") {
    redirect("/pin?error=1");
  }

  (await cookies()).set("pin", "9999", { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/");
}
