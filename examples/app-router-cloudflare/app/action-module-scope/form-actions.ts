"use server";

import { cookies } from "next/headers";
import { readModuleScopeRequest } from "./module-scope-request";

const moduleScopeRequest = readModuleScopeRequest();

export async function submitFormActionScope(_previous: string | null): Promise<string> {
  const live = (await cookies()).get("session")?.value ?? "none";
  return JSON.stringify({ moduleScope: await moduleScopeRequest, live });
}
