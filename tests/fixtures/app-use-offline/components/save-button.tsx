"use client";
import { useState, useTransition } from "react";
import { save } from "../app/action/actions";

export function SaveButton() {
  const [result, setResult] = useState<string>("none");
  const [pending, startTransition] = useTransition();
  return (
    <>
      <button
        id="save"
        onClick={() =>
          startTransition(async () => {
            setResult(String(await save()));
          })
        }
      >
        Save
      </button>
      <div id="save-pending">{pending ? "pending" : "idle"}</div>
      <div id="save-result">{result}</div>
    </>
  );
}
