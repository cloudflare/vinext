// Imports nothing, so the build has no dependency chunks to preload for it.
export default function BareThing(): null {
  Reflect.set(globalThis, "__BARE_THING_RENDERED__", VERSION_MARKER);
  return null;
}

const VERSION_MARKER = "BARE_THING_MARKER";
