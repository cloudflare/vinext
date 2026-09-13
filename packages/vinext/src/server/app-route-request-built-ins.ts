const BUILT_IN_REQUEST_PROPERTIES_KEY = Symbol.for(
  "vinext.appRouteHandlerRuntime.builtInRequestProperties",
);
const globalState = globalThis as unknown as Record<PropertyKey, unknown>;

export type BuiltInRequestProperty = {
  descriptor: PropertyDescriptor;
  instanceOnly: boolean;
  key: PropertyKey;
};

function captureBuiltInRequestProperties(
  requestInstance: Request = new Request("http://vinext.invalid/"),
): readonly BuiltInRequestProperty[] {
  const properties = new Map<PropertyKey, BuiltInRequestProperty>();
  const prototypeChain: object[] = [];
  let prototype: object | null = Reflect.getPrototypeOf(requestInstance);
  while (prototype !== null && prototype !== Object.prototype) {
    prototypeChain.push(prototype);
    prototype = Reflect.getPrototypeOf(prototype);
  }

  // Object.prototype stays excluded because its reflection helpers must keep
  // the tracked proxy as their receiver.
  for (const source of prototypeChain) {
    for (const prop of Reflect.ownKeys(source)) {
      if (properties.has(prop)) continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(source, prop);
      if (descriptor) properties.set(prop, { descriptor, instanceOnly: false, key: prop });
    }
  }

  for (const prop of Reflect.ownKeys(requestInstance)) {
    // Node stores internal Request state in own symbol keys. Worker Web IDL
    // members that are absent from the prototype surface are string-named.
    if (typeof prop !== "string" || properties.has(prop)) continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(requestInstance, prop);
    if (descriptor) properties.set(prop, { descriptor, instanceOnly: true, key: prop });
  }

  return Object.freeze([...properties.values()]);
}

/**
 * Capture the standard Request surface before route modules can extend or
 * shadow it. Workerd can place Web IDL members on intermediate prototypes or
 * directly on Request instances, so both runtime-specific layouts are included.
 * The production RSC entry imports this module ahead of userland; the global
 * symbol also preserves that first snapshot for the lazy dispatch chunk.
 */
export const BUILT_IN_REQUEST_PROPERTIES = (globalState[BUILT_IN_REQUEST_PROPERTIES_KEY] ??=
  captureBuiltInRequestProperties()) as readonly BuiltInRequestProperty[];
