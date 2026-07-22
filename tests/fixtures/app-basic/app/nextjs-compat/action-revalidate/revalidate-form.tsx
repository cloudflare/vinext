"use client";

import { useState } from "react";
import { revalidateAction, revalidateTagAction } from "./actions";

export function RevalidateForm() {
  const [count, setCount] = useState(0);

  return (
    <>
      <p id="action-revalidate-client-count">{count}</p>
      <button
        id="action-revalidate-increment"
        type="button"
        onClick={() => setCount((value) => value + 1)}
      >
        Increment
      </button>
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
