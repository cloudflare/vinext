"use client";

import { useState } from "react";

type ServerFunction = () => Promise<string>;

export function MixedOwnershipClient({
  builtinAction,
  flexibleAction,
}: {
  builtinAction: ServerFunction;
  flexibleAction: ServerFunction;
}) {
  const [builtinResult, setBuiltinResult] = useState("");
  const [builtinCalls, setBuiltinCalls] = useState(0);
  const [flexibleResult, setFlexibleResult] = useState("");
  const [flexibleCalls, setFlexibleCalls] = useState(0);

  return (
    <div>
      <button
        id="call-mixed-builtin"
        onClick={() =>
          void builtinAction().then((result) => {
            setBuiltinResult(result);
            setBuiltinCalls((count) => count + 1);
          })
        }
      >
        Call built-in action
      </button>
      <output data-testid="mixed-builtin-result">{builtinResult}</output>
      <output data-testid="mixed-builtin-call-count">{builtinCalls}</output>

      <button
        id="call-mixed-flexible"
        onClick={() =>
          void flexibleAction().then((result) => {
            setFlexibleResult(result);
            setFlexibleCalls((count) => count + 1);
          })
        }
      >
        Call flexible action
      </button>
      <output data-testid="mixed-flexible-result">{flexibleResult}</output>
      <output data-testid="mixed-flexible-call-count">{flexibleCalls}</output>
    </div>
  );
}
