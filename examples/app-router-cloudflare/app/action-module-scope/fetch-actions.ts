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

export async function callAwaitedAction(
  pending: Promise<() => Promise<ModuleScopeResult>>,
): Promise<ModuleScopeResult> {
  // React resolves a server reference inside a promise argument only once the
  // action awaits it, so this loads the referenced module mid-action.
  const action = await pending;
  return action();
}
