"use server";

import { recordActionRun } from "./action-log";
import { VERSION } from "./version";

export async function ping(): Promise<string> {
  await recordActionRun("ping");
  return `pong:${VERSION}`;
}
