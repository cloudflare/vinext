import * as React from "react";
import { runtimeCondition as workerFirstCondition } from "runtime-condition-library/worker-first";
import { runtimeCondition as workerdFirstCondition } from "runtime-condition-library/workerd-first";

let serverConditions = { workerFirst: workerFirstCondition, workerdFirst: workerdFirstCondition };
if (typeof document !== "undefined") {
  serverConditions = {
    workerFirst:
      document.querySelector('[data-testid="server-worker-first-condition"]')?.textContent ?? "",
    workerdFirst:
      document.querySelector('[data-testid="server-workerd-first-condition"]')?.textContent ?? "",
  };
}

export default function ImportConditionsPage() {
  const [clientConditions, setClientConditions] = React.useState<{
    workerFirst: string;
    workerdFirst: string;
  } | null>(null);

  React.useEffect(() => {
    setClientConditions({ workerFirst: workerFirstCondition, workerdFirst: workerdFirstCondition });
  }, []);

  return (
    <output aria-busy={clientConditions === null}>
      <span data-testid="server-worker-first-condition">{serverConditions.workerFirst}</span>
      <span data-testid="server-workerd-first-condition">{serverConditions.workerdFirst}</span>
      <span suppressHydrationWarning data-testid="client-worker-first-condition">
        {clientConditions?.workerFirst ?? "pending"}
      </span>
      <span suppressHydrationWarning data-testid="client-workerd-first-condition">
        {clientConditions?.workerdFirst ?? "pending"}
      </span>
    </output>
  );
}
