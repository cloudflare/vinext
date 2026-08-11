import { runtimeCondition as workerFirstCondition } from "runtime-condition-library/worker-first";
import { runtimeCondition as workerdFirstCondition } from "runtime-condition-library/workerd-first";

export function GET(request: Request) {
  return Response.json({
    middleware: {
      workerFirst: request.headers.get("x-middleware-worker-first-condition"),
      workerdFirst: request.headers.get("x-middleware-workerd-first-condition"),
    },
    server: { workerFirst: workerFirstCondition, workerdFirst: workerdFirstCondition },
  });
}
