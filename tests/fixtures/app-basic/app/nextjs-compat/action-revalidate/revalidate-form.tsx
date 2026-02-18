"use client";

import { revalidateAction } from "./actions";

export function RevalidateForm() {
  return (
    <form action={revalidateAction}>
      <button type="submit" id="revalidate">
        Revalidate
      </button>
    </form>
  );
}
