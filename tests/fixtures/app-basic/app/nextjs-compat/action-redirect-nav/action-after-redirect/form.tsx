"use client";

import React from "react";
import { expensiveCalculation } from "./actions";

export function Form({ randomNum }: { randomNum: number }) {
  const [isPending, setIsPending] = React.useState(false);
  const [result, setResult] = React.useState<number | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setIsPending(true);
    const res = await expensiveCalculation();
    setIsPending(false);
    setResult(res);
  }

  return (
    <form
      id="form"
      onSubmit={handleSubmit}
      style={{ display: "flex", gap: "2rem", flexDirection: "column" }}
    >
      <section>
        <button type="submit" id="submit" style={{ width: "max-content" }}>
          Submit
        </button>
        {isPending && "Loading..."}
      </section>
      <div>Server side rendered number: {randomNum}</div>
      {result && <div id="result">RESULT FROM SERVER ACTION: {result}</div>}
    </form>
  );
}
