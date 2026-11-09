"use server";

import { cookies } from "next/headers";
import type { ModuleScopeResult } from "./fetch-actions";
import { readModuleScopeRequest } from "./module-scope-request";

const moduleScopeRequest = readModuleScopeRequest();

export async function readPromiseActionScope(): Promise<ModuleScopeResult> {
  return {
    moduleScope: await moduleScopeRequest,
    live: (await cookies()).get("session")?.value ?? "none",
  };
}
