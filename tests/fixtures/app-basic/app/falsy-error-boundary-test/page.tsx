"use client";

import { useEffect, useState } from "react";

const noThrow = Symbol("no throw");

const falsyThrownValues = [
  ["undefined", undefined],
  ["null", null],
  ["zero", 0],
  ["empty-string", ""],
  ["false", false],
] satisfies readonly (readonly [string, unknown])[];

export default function FalsyErrorBoundaryTestPage() {
  const [thrownValue, setThrownValue] = useState<unknown>(noThrow);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  if (thrownValue !== noThrow) {
    throw thrownValue;
  }

  return (
    <main>
      <h1>Falsy Error Boundary Test</h1>
      <p data-testid="falsy-error-content">Ready</p>
      {falsyThrownValues.map(([name, value]) => (
        <button
          data-testid={`throw-${name}`}
          disabled={!isHydrated}
          key={name}
          onClick={() => {
            setThrownValue(value);
          }}
        >
          Throw {name}
        </button>
      ))}
    </main>
  );
}
