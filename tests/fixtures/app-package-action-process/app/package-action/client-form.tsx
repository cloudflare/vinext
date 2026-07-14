"use client";

import { packageAction } from "dev-package-action";

export function PackageActionForm() {
  return (
    <form action={packageAction}>
      <button type="submit">Run package action</button>
    </form>
  );
}
