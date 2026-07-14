"use server";

import { redirect } from "next/navigation";

const state = globalThis as typeof globalThis & {
  __vinextUnselectedActionModuleLoads?: number;
};
state.__vinextUnselectedActionModuleLoads = (state.__vinextUnselectedActionModuleLoads ?? 0) + 1;

export async function unselectedAction() {
  redirect("/unselected-success");
}
