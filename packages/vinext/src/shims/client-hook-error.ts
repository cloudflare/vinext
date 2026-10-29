/**
 * Shared error helper for client-only hooks called in Server Components.
 *
 * Used by `.react-server.ts` shim variants to provide a clear, actionable
 * error message when a developer forgets the "use client" directive.
 *
 * @see https://github.com/cloudflare/vinext/issues/834
 */
export function buildClientHookErrorMessage(hookName: string): string {
  return (
    `${hookName} only works in Client Components. Add the "use client" directive ` +
    `at the top of the file to use it. Read more: ` +
    `https://nextjs.org/docs/messages/react-client-hook-in-server-component`
  );
}

export function throwClientHookError(hookName: string): never {
  throw new Error(buildClientHookErrorMessage(hookName));
}

// React client-only hooks that are absent from the `react-server` export
// condition. When called in a Server Component they produce a TypeError like
// "useState is not a function".
const clientHookPattern =
  /\b(useState|useEffect|useReducer|useRef|useContext|useLayoutEffect|useInsertionEffect|useSyncExternalStore|useTransition|useImperativeHandle|useDeferredValue|useActionState|useOptimistic|useEffectEvent)\b.*is not a function/;

/** Rewrites that TypeError into the actionable message above. */
export function rewriteClientHookError(error: Error): void {
  const match = error.message.match(clientHookPattern);
  if (!match) return;
  const message = buildClientHookErrorMessage(`${match[1]}()`);
  // The stack's first line repeats the message, and console.error prints it.
  if (error.stack) {
    const lines = error.stack.split("\n");
    lines[0] = `${error.name}: ${message}`;
    error.stack = lines.join("\n");
  }
  error.message = message;
}
