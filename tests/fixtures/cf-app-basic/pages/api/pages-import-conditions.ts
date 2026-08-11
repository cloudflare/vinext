import type { NextApiRequest, NextApiResponse } from "next";
import { runtimeCondition as workerFirstCondition } from "runtime-condition-library/worker-first";
import { runtimeCondition as workerdFirstCondition } from "runtime-condition-library/workerd-first";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({
    middleware: {
      workerFirst: req.headers["x-middleware-worker-first-condition"],
      workerdFirst: req.headers["x-middleware-workerd-first-condition"],
    },
    server: { workerFirst: workerFirstCondition, workerdFirst: workerdFirstCondition },
  });
}
