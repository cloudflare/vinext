"use client";

import * as React from "react";
import { runtimeCondition as workerFirstCondition } from "runtime-condition-library/worker-first";
import { runtimeCondition as workerdFirstCondition } from "runtime-condition-library/workerd-first";

export default function ClientConditions({
  action,
  serverConditions,
}: {
  action: () => Promise<{ workerFirst: string; workerdFirst: string }>;
  serverConditions: { workerFirst: string; workerdFirst: string };
}) {
  const [actionConditions, formAction, isPending] = React.useActionState(action, {
    workerFirst: "pending",
    workerdFirst: "pending",
  });
  const [clientConditions, setClientConditions] = React.useState({
    workerFirst: "pending",
    workerdFirst: "pending",
  });

  React.useEffect(() => {
    setClientConditions({ workerFirst: workerFirstCondition, workerdFirst: workerdFirstCondition });
  }, []);

  return (
    <form action={formAction}>
      <span data-testid="server-worker-first-condition">{serverConditions.workerFirst}</span>
      <span data-testid="server-workerd-first-condition">{serverConditions.workerdFirst}</span>
      <span data-testid="client-worker-first-condition">{clientConditions.workerFirst}</span>
      <span data-testid="client-workerd-first-condition">{clientConditions.workerdFirst}</span>
      <span data-testid="action-worker-first-condition" aria-busy={isPending}>
        {actionConditions.workerFirst}
      </span>
      <span data-testid="action-workerd-first-condition" aria-busy={isPending}>
        {actionConditions.workerdFirst}
      </span>
      <button type="submit">Resolve action condition</button>
    </form>
  );
}
