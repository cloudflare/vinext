"use server";

import { redirect } from "next/navigation";

export async function redirectAction() {
  redirect("/success");
}

export async function redirectOtherAction() {
  redirect("/other-success");
}

export async function redirectBoundAction(target: string) {
  redirect(target);
}

export async function stateAction(_previousState: { value: string }, formData: FormData) {
  return { value: `state:${String(formData.get("value"))}` };
}

export async function unboundStateAction(formData: FormData) {
  return { value: `unbound:${String(formData.get("value"))}` };
}

export async function successfulFetchAction() {
  return "fetch-success";
}

export async function failedFetchAction() {
  throw new Error("fetch-action-failure");
}
