"use server";

export async function publicSharedAction() {
  return "PUBLIC_SHARED_ACTION_EXECUTED";
}

export async function adminSharedAction() {
  return "ADMIN_SHARED_ACTION_EXECUTED";
}
