import { escapeHtmlAttr } from "./html.js";

type ClientTraceEntry = {
  key: string;
  value: string;
};

type OpenTelemetryApi = {
  context: {
    active(): unknown;
    with<T>(context: unknown, fn: () => T): T;
  };
  propagation: {
    inject(context: unknown, carrier: ClientTraceEntry[], setter: unknown): void;
  };
  trace: {
    setSpan(context: unknown, span: unknown): unknown;
    wrapSpanContext(context: unknown): unknown;
  };
  TraceFlags?: {
    SAMPLED?: number;
  };
};

type OpenTelemetryLoader = () => Promise<OpenTelemetryApi>;

const traceDataSetter = {
  set(carrier: ClientTraceEntry[], key: string, value: unknown) {
    carrier.push({ key, value: String(value) });
  },
};

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

function isValidMetadataKey(key: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/.test(key);
}

async function loadOpenTelemetryApi(): Promise<OpenTelemetryApi> {
  // Keep @opentelemetry/api optional. Next apps that configure tracing install
  // it themselves; apps without it should simply render no trace metadata.
  const specifier = ["@opentelemetry", "api"].join("/");
  return import(/* @vite-ignore */ specifier) as Promise<OpenTelemetryApi>;
}

export async function getClientTraceMetadataHtml(
  clientTraceMetadata: readonly string[] | undefined,
  loadApi: OpenTelemetryLoader = loadOpenTelemetryApi,
): Promise<string> {
  if (!clientTraceMetadata?.length) return "";

  let api: OpenTelemetryApi;
  try {
    api = await loadApi();
  } catch {
    return "";
  }

  const allowedKeys = new Set(clientTraceMetadata);
  const entries: ClientTraceEntry[] = [];
  const spanContext = {
    traceId: randomHex(16),
    spanId: randomHex(8),
    traceFlags: api.TraceFlags?.SAMPLED ?? 1,
  };
  const activeContext = api.trace.setSpan(
    api.context.active(),
    api.trace.wrapSpanContext(spanContext),
  );

  api.context.with(activeContext, () => {
    api.propagation.inject(activeContext, entries, traceDataSetter);
  });

  return entries
    .filter(({ key }) => allowedKeys.has(key) && isValidMetadataKey(key))
    .map(
      ({ key, value }) => `<meta name="${escapeHtmlAttr(key)}" content="${escapeHtmlAttr(value)}">`,
    )
    .join("");
}

export function injectHtmlBeforeHeadClose(
  stream: ReadableStream<Uint8Array>,
  html: string,
): ReadableStream<Uint8Array> {
  if (!html) return stream;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let injected = false;
  let buffered = "";

  const flushBuffered = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (!buffered) return;
    if (!injected) {
      const index = buffered.indexOf("</head>");
      if (index !== -1) {
        buffered = buffered.slice(0, index) + html + buffered.slice(index);
        injected = true;
      }
    }
    controller.enqueue(encoder.encode(buffered));
    buffered = "";
  };

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffered += decoder.decode(chunk, { stream: true });
        if (injected || buffered.includes("</head>") || buffered.length > 8192) {
          flushBuffered(controller);
        }
      },
      flush(controller) {
        buffered += decoder.decode();
        if (!injected) {
          const index = buffered.indexOf("</head>");
          if (index !== -1) {
            buffered = buffered.slice(0, index) + html + buffered.slice(index);
            injected = true;
          } else {
            buffered += html;
          }
        }
        flushBuffered(controller);
      },
    }),
  );
}
