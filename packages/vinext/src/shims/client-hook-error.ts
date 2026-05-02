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
