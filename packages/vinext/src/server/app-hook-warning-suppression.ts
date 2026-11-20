import { AsyncLocalStorage } from "node:async_hooks";

export const suppressHookWarningAls = new AsyncLocalStorage<boolean>();

// In dev, the server this was evaluated for puts console.error back when it
// closes; see plugins/react-server-dom-async-hook.ts.
const consoleLayer = (
  globalThis as typeof globalThis & {
    [key: symbol]: { consoleLayer(kind: string): { record(): void } | undefined } | undefined;
  }
)[Symbol.for("vinext.devServerOwners")]?.consoleLayer("hook-warning");

const _origConsoleError = console.error;
console.error = (...args: unknown[]) => {
  if (
    suppressHookWarningAls.getStore() === true &&
    typeof args[0] === "string" &&
    args[0].includes("Invalid hook call")
  )
    return;
  _origConsoleError.apply(console, args);
};
consoleLayer?.record();
