import fs from "node:fs";
import path from "node:path";

type Attribute = { type?: string; value?: unknown };

type TransactionEvent = {
  breadcrumbs?: Array<{ category?: string; data?: Record<string, unknown> }>;
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
  tags?: Record<string, string>;
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
      stacktrace?: { frames?: Array<{ filename?: string; in_app?: boolean }> };
      value?: string;
    }>;
  };
  message?: string;
  request?: TransactionEvent["request"];
  transaction?: string;
  tags?: Record<string, string>;
};

type EnvelopeItem = [
  { content_type?: string; item_count?: number; type?: string },
  Record<string, unknown>,
];

type Metric = {
  attributes?: Record<string, Attribute>;
  name?: string;
  span_id?: string;
  timestamp?: number;
  trace_id?: string;
  type?: string;
  value?: number;
};

type StreamedSpan = {
  attributes: Record<string, Attribute>;
  is_segment?: boolean;
  name?: string;
  span_id?: string;
  status?: string;
  trace_id: string;
};

function getNanosecondTimestamp(): number {
  const [seconds, nanoseconds] = process.hrtime();
  return seconds * 1e9 + nanoseconds;
}

async function waitForEvent<T>(
  endpoint: "errors" | "transactions",
  predicate: (event: T) => boolean | Promise<boolean>,
): Promise<T> {
  const after = getNanosecondTimestamp();
  const deadline = Date.now() + 10_000;
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

async function waitForItem(
  predicate: (item: EnvelopeItem) => boolean | Promise<boolean>,
): Promise<EnvelopeItem> {
  const after = getNanosecondTimestamp();
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:3031/items?after=${after}`);
    const stored = (await response.json()) as Array<{
      body: Record<string, unknown>;
      header: EnvelopeItem[0];
    }>;
    for (const { body, header } of stored) {
      const item: EnvelopeItem = [header, body];
      if (await predicate(item)) return item;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Timed out waiting for a matching Sentry envelope item");
}

export function waitForEnvelopeItem(
  _proxyServerName: string,
  predicate: (item: EnvelopeItem) => boolean | Promise<boolean>,
): Promise<EnvelopeItem> {
  return waitForItem(predicate);
}

export async function waitForMetric(
  _proxyServerName: string,
  predicate: (metric: Metric) => boolean | Promise<boolean>,
): Promise<Metric> {
  let match: Metric | undefined;
  await waitForItem(async ([header, body]) => {
    if (header.type !== "trace_metric" || !Array.isArray(body.items)) return false;
    for (const metric of body.items as Metric[]) {
      if (await predicate(metric)) {
        match = metric;
        return true;
      }
    }
    return false;
  });
  return match!;
}

export async function waitForStreamedSpans(
  _proxyServerName: string,
  predicate?: (spans: StreamedSpan[]) => boolean | Promise<boolean>,
): Promise<StreamedSpan[]> {
  let match: StreamedSpan[] | undefined;
  await waitForItem(async ([header, body]) => {
    if (
      header.type !== "span" ||
      header.content_type !== "application/vnd.sentry.items.span.v2+json" ||
      !Array.isArray(body.items)
    ) {
      return false;
    }
    const spans = body.items as StreamedSpan[];
    if (!predicate || (await predicate(spans))) {
      match = spans;
      return true;
    }
    return false;
  });
  return match!;
}

export function getSpanOp(span: StreamedSpan): string | undefined {
  const operation = span.attributes["sentry.op"];
  return operation?.type === "string" && typeof operation.value === "string"
    ? operation.value
    : undefined;
}

export function findAbsolutePathImports({ outputDir }: { outputDir: string }): string[] {
  const leaks: string[] = [];
  const patterns = [
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\bfrom\s*["']([^"']+)["']/g,
  ];

  for (const entry of fs.readdirSync(outputDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.[cm]?js$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const contents = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of contents.matchAll(pattern)) {
        if (path.isAbsolute(match[1]!)) leaks.push(`${path.relative(process.cwd(), file)} -> ${match[1]}`);
      }
    }
  }

  return leaks;
}
