"use server";

import { refresh } from "next/cache";
import { setFlag } from "./state";

export async function setFlagAction(value: boolean): Promise<boolean> {
  return setFlag(value);
}

export async function setFlagAndRefreshAction(value: boolean): Promise<boolean> {
  const nextValue = setFlag(value);
  refresh();
  return nextValue;
}
