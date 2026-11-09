"use client";

import { useState } from "react";
import { readNested } from "./actions";

export function NestedReader({ id }: { id: string }) {
  const [reads, setReads] = useState<string[]>([]);
  return (
    <>
      <button
        id="read-nested"
        type="button"
        onClick={async () => {
          const nonce = await readNested(id);
          setReads((previous) => [...previous, nonce]);
        }}
      >
        Read
      </button>
      <ol id="nested-reads">
        {reads.map((nonce, index) => (
          <li key={index}>{nonce}</li>
        ))}
      </ol>
    </>
  );
}
