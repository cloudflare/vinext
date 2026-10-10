"use server";

import { cookies } from "next/headers";
import { readModuleScopeRequest } from "./module-scope-request";

const moduleScopeRequest = readModuleScopeRequest();

export type ModuleScopeResult = { moduleScope: string; live: string };

export async function readFetchActionScope(): Promise<ModuleScopeResult> {
  return {
    moduleScope: await moduleScopeRequest,
    live: (await cookies()).get("session")?.value ?? "none",
  };
}

export async function callPassedAction(
  action: () => Promise<ModuleScopeResult>,
): Promise<ModuleScopeResult> {
  return action();
}
