type TransactionEvent = {
  transaction?: string;
  contexts?: {
    trace?: {
      data?: Record<string, unknown>;
      op?: string;
      origin?: string;
      span_id?: string;
      status?: string;
      trace_id?: string;
    };
  };
  request?: { url?: string };
  spans?: Array<{ description?: string }>;
};

export async function waitForTransaction(
  _proxyServerName: string,
  predicate: (event: TransactionEvent) => boolean | Promise<boolean>,
): Promise<TransactionEvent> {
  const after = Date.now();
  const deadline = after + 10_000;
  let observed: TransactionEvent[] = [];

  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:3031/transactions?after=${after}`);
    const transactions = (await response.json()) as Array<{ event: TransactionEvent }>;
    observed = transactions.map(({ event }) => event);
    for (const { event } of transactions) {
      if (await predicate(event)) return event;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `Timed out waiting for a matching Sentry transaction; observed: ${observed
      .map(({ transaction }) => transaction)
      .join(", ")}`,
  );
}
