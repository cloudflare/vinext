"use client";

import Link from "next/link";
import { use, useState } from "react";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [count, setCount] = useState(0);

  return (
    <main>
      <div id="children-slot-id">{id}</div>
      <div id="children-slot-count">{count}</div>
      <button id="children-slot-increment" onClick={() => setCount((value) => value + 1)}>
        Increment
      </button>
      <Link
        id="children-slot-next"
        href={`/nextjs-compat/client-cache-children-slot/${id === "one" ? "two" : "one"}`}
      >
        Next
      </Link>
    </main>
  );
}
