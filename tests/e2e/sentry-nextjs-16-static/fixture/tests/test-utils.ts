type TransactionEvent = {
  environment?: string;
  transaction?: string;
  contexts?: {
    react?: { version?: string };
    trace?: {
      data?: Record<string, unknown>;
      description?: string;
      op?: string;
      origin?: string;
      span_id?: string;
      status?: string;
      trace_id?: string;
    };
  };
  request?: { headers?: Record<string, string>; method?: string; url?: string };
  spans?: Array<{
    data?: Record<string, unknown>;
    description?: string;
    op?: string;
    origin?: string;
    status?: string;
  }>;
  start_timestamp?: number;
  timestamp?: number;
  transaction_info?: { source?: string };
  type?: string;
};

type ErrorEvent = {
  contexts?: TransactionEvent["contexts"] & {
    nextjs?: {
      request_path?: string;
      route_type?: string;
      router_kind?: string;
      router_path?: string;
    };
  };
  exception?: {
    values?: Array<{
      mechanism?: { handled?: boolean; type?: string };
      value?: string;
    }>;
  };
  message?: string;
  request?: TransactionEvent["request"];
  transaction?: string;
};

async function waitForEvent<T>(
  endpoint: "errors" | "transactions",
  predicate: (event: T) => boolean | Promise<boolean>,
): Promise<T> {
  const after = Date.now();
  const deadline = after + 10_000;
  let observed: T[] = [];

  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:3031/${endpoint}?after=${after}`);
    const events = (await response.json()) as Array<{ event: T }>;
    observed = events.map(({ event }) => event);
    for (const { event } of events) {
      if (await predicate(event)) return event;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `Timed out waiting for a matching Sentry ${endpoint}; observed ${observed.length} event(s)`,
  );
}

export async function waitForTransaction(
  _proxyServerName: string,
  predicate: (event: TransactionEvent) => boolean | Promise<boolean>,
): Promise<TransactionEvent> {
  return waitForEvent("transactions", predicate);
}

export async function waitForError(
  _proxyServerName: string,
  predicate: (event: ErrorEvent) => boolean | Promise<boolean>,
): Promise<ErrorEvent> {
  return waitForEvent("errors", predicate);
}
