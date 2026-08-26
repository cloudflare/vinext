import { getDataCacheHandler } from "vinext/shims/cache-handler";

const privateExecutionKey = Symbol.for("vinext.test.privateInUnstableCache.executions");
const fillGateKey = "test:cacheability-private-in-unstable:gate";
const fillWaitingKey = "test:cacheability-private-in-unstable:waiting";
const fillExecutionsKey = "test:cacheability-private-in-unstable:fill-executions";
const globals = globalThis as unknown as Record<PropertyKey, unknown>;

async function writeTestState(key: string, value: unknown): Promise<void> {
  await getDataCacheHandler().set(
    key,
    {
      kind: "FETCH",
      data: { body: JSON.stringify(value), headers: {}, url: key },
      revalidate: false,
      tags: [],
    },
    { fetchCache: true, tags: [] },
  );
}

async function readTestState<T>(key: string): Promise<T | null> {
  const entry = await getDataCacheHandler().get(key, { kind: "FETCH", tags: [] });
  if (!entry?.value || entry.value.kind !== "FETCH") return null;
  return JSON.parse(entry.value.data.body) as T;
}

export function recordPrivateExecution(): number {
  const next =
    (typeof globals[privateExecutionKey] === "number" ? globals[privateExecutionKey] : 0) + 1;
  globals[privateExecutionKey] = next;
  return next;
}

export function getPrivateExecutions(): number {
  return typeof globals[privateExecutionKey] === "number" ? globals[privateExecutionKey] : 0;
}

export async function resetPrivateFillGate(): Promise<void> {
  globals[privateExecutionKey] = 0;
  await Promise.all([
    writeTestState(fillGateKey, "wait"),
    writeTestState(fillWaitingKey, false),
    writeTestState(fillExecutionsKey, 0),
  ]);
}

export async function waitForPrivateFillRelease(): Promise<void> {
  const executions = (await readTestState<number>(fillExecutionsKey)) ?? 0;
  await Promise.all([
    writeTestState(fillExecutionsKey, executions + 1),
    writeTestState(fillWaitingKey, true),
  ]);
  try {
    while ((await readTestState<string>(fillGateKey)) === "wait") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await writeTestState(fillWaitingKey, false);
  }
}

export async function releasePrivateFillGate(): Promise<void> {
  await writeTestState(fillGateKey, "release");
}

export async function getPrivateFillState(): Promise<{
  executions: number;
  waiting: boolean;
}> {
  const [executions, waiting] = await Promise.all([
    readTestState<number>(fillExecutionsKey),
    readTestState<boolean>(fillWaitingKey),
  ]);
  return { executions: executions ?? 0, waiting: waiting ?? false };
}
