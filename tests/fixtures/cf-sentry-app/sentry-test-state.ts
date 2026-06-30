export type ReportedSentryError = {
  message: string;
  projectId: string;
  requestPath?: string;
  routerKind?: string;
  routerPath?: string;
  routeType?: string;
  sdkName?: string;
};

type SentryTestState = {
  errors: ReportedSentryError[];
};

const STATE_KEY = "__VINEXT_SENTRY_TEST_STATE__";

function getState(): SentryTestState {
  const scopedGlobal = globalThis as typeof globalThis & {
    [STATE_KEY]?: SentryTestState;
  };

  if (!scopedGlobal[STATE_KEY]) {
    scopedGlobal[STATE_KEY] = { errors: [] };
  }

  return scopedGlobal[STATE_KEY];
}

export function getReportedSentryErrors(): ReportedSentryError[] {
  return [...getState().errors];
}

export function recordSentryErrorReport(projectId: string, envelope: string): void {
  const event = envelope
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as {
          exception?: { values?: Array<{ value?: string }> };
          contexts?: {
            nextjs?: {
              request_path?: string;
              router_kind?: string;
              router_path?: string;
              route_type?: string;
            };
          };
          sdk?: { name?: string };
        };
      } catch {
        return null;
      }
    })
    .find((item) => item?.exception);

  const nextjsContext = event?.contexts?.nextjs;
  getState().errors.push({
    message: event?.exception?.values?.[0]?.value ?? "",
    projectId,
    requestPath: nextjsContext?.request_path,
    routerKind: nextjsContext?.router_kind,
    routerPath: nextjsContext?.router_path,
    routeType: nextjsContext?.route_type,
    sdkName: event?.sdk?.name,
  });
}

export function resetSentryReports(): void {
  getState().errors.length = 0;
}
