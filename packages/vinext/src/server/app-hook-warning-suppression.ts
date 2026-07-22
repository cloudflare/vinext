import { AsyncLocalStorage } from "node:async_hooks";

export const suppressHookWarningAls = new AsyncLocalStorage<boolean>();

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
