"use client";

import { revalidateAction, revalidateTagAction } from "./actions";

export function RevalidateForm() {
  return (
    <>
      <form action={revalidateAction}>
        <button type="submit" id="revalidate">
          Revalidate path
        </button>
      </form>
      <form action={revalidateTagAction}>
        <button type="submit" id="revalidate-tag">
          Revalidate tag
        </button>
      </form>
    </>
  );
}
