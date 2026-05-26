export type AppRouterScrollIntent = Readonly<{
  hash: string | null;
  id: number;
}>;

let nextAppRouterScrollIntentId = 0;
let pendingAppRouterScrollIntent: AppRouterScrollIntent | null = null;

export function beginAppRouterScrollIntent(hash: string | null): AppRouterScrollIntent {
  nextAppRouterScrollIntentId += 1;
  const intent = {
    hash,
    id: nextAppRouterScrollIntentId,
  };
  pendingAppRouterScrollIntent = intent;
  return intent;
}

export function clearAppRouterScrollIntent(): void {
  pendingAppRouterScrollIntent = null;
}

export function getPendingAppRouterScrollIntent(): AppRouterScrollIntent | null {
  return pendingAppRouterScrollIntent;
}

export function consumeAppRouterScrollIntent(
  expected?: AppRouterScrollIntent,
): AppRouterScrollIntent | null {
  const intent = pendingAppRouterScrollIntent;
  if (intent === null) return null;
  if (expected && intent.id !== expected.id) return null;

  pendingAppRouterScrollIntent = null;
  return intent;
}
