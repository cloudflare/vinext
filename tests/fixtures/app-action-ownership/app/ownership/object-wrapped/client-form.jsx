"use client";

import { commands } from "./commands";

export function ClientForm() {
  return (
    <form action={commands.objectWrappedAction}>
      <button data-testid="object-wrapped">Run object-wrapped action</button>
    </form>
  );
}
