import {
  markRegisterCalled,
  recordRequestError,
} from "./instrumentation-state";

export async function register(): Promise<void> {
  markRegisterCalled();
}

export async function onRequestError(
  error: Error,
  request: { path: string; method: string; headers: Record<string, string> },
  context: {
    routerKind: string;
    routePath: string;
    routeType: string;
  },
): Promise<void> {
  recordRequestError({
    message: error.message,
    path: request.path,
    method: request.method,
    routerKind: context.routerKind,
    routePath: context.routePath,
    routeType: context.routeType,
  });
}
