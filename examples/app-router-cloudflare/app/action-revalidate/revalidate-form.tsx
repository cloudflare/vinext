"use client";

import { useState } from "react";
import { revalidateAction } from "./actions";

export function RevalidateForm() {
  const [count, setCount] = useState(0);

  return (
    <>
      <p data-testid="action-revalidate-client-count">Client count: {count}</p>
      <button
        data-testid="action-revalidate-increment"
        type="button"
        onClick={() => setCount((value) => value + 1)}
      >
        Increment client count
      </button>
      <form action={revalidateAction}>
        <button data-testid="action-revalidate-submit" type="submit">
          Revalidate path
        </button>
      </form>
    </>
  );
}
