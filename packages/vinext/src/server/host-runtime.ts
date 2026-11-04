// Set by `vinext/internal/server/workerd-host`, which vinext and
// @vinext/cloudflare import into every Worker entry. Runtime globals can't
// identify workerd: `navigator` is absent under `no_global_navigator`.
const WORKERD_HOST = Symbol.for("vinext.workerdHost");

export function markWorkerdHost(): void {
  Reflect.set(globalThis, WORKERD_HOST, true);
}

export function isWorkerdHost(): boolean {
  return Reflect.get(globalThis, WORKERD_HOST) === true;
}
