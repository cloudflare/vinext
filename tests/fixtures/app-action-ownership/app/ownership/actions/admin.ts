"use server";
export async function publicAction() {
  return "PUBLIC_OK";
}
export async function $$hoist_0_adminOnly() {
  return "ADMIN_ONLY_EXECUTED";
}
