import esmJsValue from "fake-worker-context-lib/worker-esm-js";
import esmMjsValue from "fake-worker-context-lib/worker-esm-mjs";
import { useEffect, useState } from "react";

export function currentWorkerEsmValue(): string {
  return `${esmJsValue}+${esmMjsValue}`;
}

export function WorkerEsmPage({ serverValue }: { serverValue?: string }) {
  const [clientValue, setClientValue] = useState(serverValue ?? null);

  useEffect(() => {
    setClientValue(currentWorkerEsmValue());
  }, []);

  return (
    <main>
      <p id="worker-esm-value" suppressHydrationWarning>
        {clientValue ?? currentWorkerEsmValue()}
        {serverValue ? `|${serverValue}` : ""}
      </p>
    </main>
  );
}
