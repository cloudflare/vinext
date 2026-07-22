"use server";

import { refresh } from "next/cache";
import { incrementValue } from "./state";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function slowAction(): Promise<number> {
  await wait(800);
  return incrementValue();
}

export async function slowActionWithRefresh(): Promise<number> {
  await wait(800);
  const value = incrementValue();
  refresh();
  return value;
}
