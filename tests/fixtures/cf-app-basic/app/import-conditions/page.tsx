import { runtimeCondition as workerFirstCondition } from "runtime-condition-library/worker-first";
import { runtimeCondition as workerdFirstCondition } from "runtime-condition-library/workerd-first";
import ClientConditions from "./ClientConditions";

async function resolveActionCondition() {
  "use server";
  return { workerFirst: workerFirstCondition, workerdFirst: workerdFirstCondition };
}

export default function ImportConditionsPage() {
  return (
    <ClientConditions
      action={resolveActionCondition}
      serverConditions={{ workerFirst: workerFirstCondition, workerdFirst: workerdFirstCondition }}
    />
  );
}
