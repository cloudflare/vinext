/**
 * A Workers WebSocket upgrade: status 101 with the Workers-only `webSocket`
 * property, from a `WebSocketPair`, a service binding or a Durable Object.
 * workerd's `Response` constructor rejects status 101 unless its init carries
 * that `webSocket`, and nothing caches or decorates an upgrade, so it must
 * reach the runtime as the application returned it.
 * https://developers.cloudflare.com/workers/runtime-apis/websockets/
 */
export function isWebSocketUpgradeResponse(response: Response): boolean {
  return (
    response.status === 101 || Boolean((response as Response & { webSocket?: unknown }).webSocket)
  );
}
