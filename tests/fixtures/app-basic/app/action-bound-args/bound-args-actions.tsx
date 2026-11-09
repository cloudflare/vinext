"use client";

import { useState } from "react";

export function BoundArgsActions({
  preview,
  readSecret,
}: {
  preview: () => Promise<string>;
  readSecret: () => Promise<string>;
}) {
  const [result, setResult] = useState("");
  return (
    <>
      <button id="preview" onClick={async () => setResult(await preview())}>
        Preview
      </button>
      <button id="read-secret" onClick={async () => setResult(await readSecret())}>
        Read secret
      </button>
      <p id="result">{result}</p>
    </>
  );
}
