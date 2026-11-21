/**
 * Graceful shutdown for the Node production server (`vinext start`, the
 * standalone `server.js` and custom entries that call `startProdServer`).
 *
 * Like `next start` and Next.js's standalone server
 * (packages/next/src/server/lib/start-server.ts), SIGINT and SIGTERM stop the
 * server accepting connections and let in-flight requests finish. Background
 * work handed to `waitUntil`, which includes `after()` callbacks, then
 * settles, as Next.js's `nextServer.close()` awaits its internal waitUntil.
 * The process exits with 128 + the signal number. Setting
 * `NEXT_MANUAL_SIG_HANDLE` leaves both signals to the app, as in Next.js.
 */
import type { Server } from "node:http";

type TerminationSignal = "SIGINT" | "SIGTERM";

const servers = new Set<Server>();
const backgroundWork = new Set<Promise<void>>();
let shutdownStarted = false;

/** Keep the process alive for `promise` during a graceful shutdown. */
export function trackBackgroundWork(promise: Promise<unknown>): void {
  // A rejection is the task's own failure. Like Next.js, log it rather than
  // let it surface as an unhandled rejection or stop the shutdown.
  const settled = Promise.resolve(promise).then(
    () => {},
    (error: unknown) => console.error(error),
  );
  backgroundWork.add(settled);
  void settled.then(() => backgroundWork.delete(settled));
}

/** Close `server` gracefully when the process receives SIGINT or SIGTERM. */
export function closeServerOnTerminationSignals(server: Server): void {
  if (process.env.NEXT_MANUAL_SIG_HANDLE) return;
  // The listeners exist only while a server is open, so servers that were
  // started and closed again (tests, scripts) leave no handlers behind.
  if (servers.size === 0 && !shutdownStarted) {
    process.on("SIGINT", onTerminationSignal);
    process.on("SIGTERM", onTerminationSignal);
  }
  servers.add(server);
  server.once("close", () => {
    servers.delete(server);
    if (servers.size === 0 && !shutdownStarted) {
      process.off("SIGINT", onTerminationSignal);
      process.off("SIGTERM", onTerminationSignal);
    }
  });
}

function onTerminationSignal(signal: TerminationSignal): void {
  // Ctrl+C in a shell signals the whole process group, so the same shutdown
  // can be requested more than once.
  if (shutdownStarted) return;
  shutdownStarted = true;
  void shutDown(signal);
}

async function shutDown(signal: TerminationSignal): Promise<void> {
  // Tracked work may wait only on unreferenced handles, so hold the event
  // loop open until it settles.
  const keepAlive = setInterval(() => {}, 60_000);
  // In-flight requests can still schedule background work, so they finish
  // before it is awaited. Repeat for servers that finished starting, and work
  // scheduled, after the signal.
  do {
    await Promise.all([...servers].map(closeServer));
    await Promise.all(backgroundWork);
  } while (servers.size > 0 || backgroundWork.size > 0);
  clearInterval(keepAlive);
  process.exit(signal === "SIGINT" ? 130 : 143);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.once("close", () => resolve());
    // An app may already have called close(); its "close" still waits for
    // the open connections.
    if (server.listening) server.close();
  });
}
