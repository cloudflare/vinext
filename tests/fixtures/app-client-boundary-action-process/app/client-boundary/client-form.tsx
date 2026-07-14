"use client";

import { clientBoundaryAction } from "./actions";

export function ClientForm() {
  return (
    <form action={clientBoundaryAction}>
      <button type="submit">Run client-boundary action</button>
    </form>
  );
}
