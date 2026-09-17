export type ReportedSentryError = {
  message: string;
  projectId: string;
  requestPath?: string;
  routerKind?: string;
  routerPath?: string;
  routeType?: string;
  sdkName?: string;
};

export type ReportedSentrySpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operation?: string;
  status?: string;
  attributes: Record<string, unknown>;
};

export type ReportedSentryTransaction = ReportedSentrySpan & {
  projectId: string;
  source?: string;
  spans: ReportedSentrySpan[];
};

type SentryTestState = {
  errors: ReportedSentryError[];
  transactions: ReportedSentryTransaction[];
};

const STATE_KEY = "__VINEXT_SENTRY_TEST_STATE__";

function getState(): SentryTestState {
  const scopedGlobal = globalThis as typeof globalThis & {
    [STATE_KEY]?: SentryTestState;
  };

  if (!scopedGlobal[STATE_KEY]) {
    scopedGlobal[STATE_KEY] = { errors: [], transactions: [] };
  }

  return scopedGlobal[STATE_KEY];
}

export function getReportedSentryErrors(): ReportedSentryError[] {
  return [...getState().errors];
}

export function getReportedSentryTransactions(): ReportedSentryTransaction[] {
  return [...getState().transactions];
}

type SentryEnvelopeEvent = {
  type?: string;
  transaction?: string;
  transaction_info?: { source?: string };
  exception?: { values?: Array<{ value?: string }> };
  contexts?: {
    nextjs?: {
      request_path?: string;
      router_kind?: string;
      router_path?: string;
      route_type?: string;
    };
    trace?: {
      data?: Record<string, unknown>;
      op?: string;
      parent_span_id?: string;
      span_id?: string;
      status?: string;
      trace_id?: string;
    };
  };
  sdk?: { name?: string };
  spans?: Array<{
    data?: Record<string, unknown>;
    description?: string;
    op?: string;
    parent_span_id?: string;
    span_id?: string;
    status?: string;
    trace_id?: string;
  }>;
};

export function recordSentryEnvelope(projectId: string, envelope: string): void {
  const items = envelope.split("\n").map((line) => {
    try {
      return JSON.parse(line) as SentryEnvelopeEvent;
    } catch {
      return null;
    }
  });

  const event = items.find((item) => item?.exception);
  if (event) {
    const nextjsContext = event.contexts?.nextjs;
    getState().errors.push({
      message: event.exception?.values?.[0]?.value ?? "",
      projectId,
      requestPath: nextjsContext?.request_path,
      routerKind: nextjsContext?.router_kind,
      routerPath: nextjsContext?.router_path,
      routeType: nextjsContext?.route_type,
      sdkName: event.sdk?.name,
    });
  }

  const transaction = items.find(
    (item) => item?.type === "transaction" && item.contexts?.trace?.span_id,
  );
  const trace = transaction?.contexts?.trace;
  if (!transaction || !trace?.trace_id || !trace.span_id) return;

  getState().transactions.push({
    name: transaction.transaction ?? "",
    projectId,
    traceId: trace.trace_id,
    spanId: trace.span_id,
    parentSpanId: trace.parent_span_id,
    operation: trace.op,
    status: trace.status,
    source: transaction.transaction_info?.source,
    attributes: trace.data ?? {},
    spans: (transaction.spans ?? []).flatMap((span) =>
      span.trace_id && span.span_id
        ? [
            {
              name: span.description ?? "",
              traceId: span.trace_id,
              spanId: span.span_id,
              parentSpanId: span.parent_span_id,
              operation: span.op,
              status: span.status,
              attributes: span.data ?? {},
            },
          ]
        : [],
    ),
  });
}

export function resetSentryReports(): void {
  getState().errors.length = 0;
  getState().transactions.length = 0;
}
