/**
 * The React Compiler option landed in @vitejs/plugin-react 6.1. Older versions
 * accept an unknown `compiler` key in their options object and silently drop
 * it, which would leave the compiler disabled while the config says otherwise.
 *
 * The plugin factory only returns `vite:react-compiler` when the installed
 * version understands the option, so its presence is what we probe for.
 */
export const REACT_COMPILER_PLUGIN_NAME = "vite:react-compiler";

/** Whether the user asked for the React Compiler through vinext's `react` option. */
export function isReactCompilerRequested(reactOptions: unknown): boolean {
  if (!reactOptions || typeof reactOptions !== "object") return false;
  return Boolean((reactOptions as { compiler?: unknown }).compiler);
}

/** Whether a plugin entry is the React Compiler plugin. */
export function isReactCompilerPlugin(plugin: unknown): boolean {
  return (
    typeof plugin === "object" &&
    plugin !== null &&
    (plugin as { name?: unknown }).name === REACT_COMPILER_PLUGIN_NAME
  );
}

/** Whether the resolved @vitejs/plugin-react actually registered the compiler. */
export function hasReactCompilerPlugin(plugins: readonly unknown[]): boolean {
  return plugins.some(isReactCompilerPlugin);
}

/** Message for when `react: { compiler: true }` cannot be honored. */
export function reactCompilerUnsupportedMessage(installCommand: string): string {
  return (
    "vinext: `react: { compiler: true }` requires @vitejs/plugin-react 6.1 or newer.\n" +
    "The installed version ignores the option, which would leave the React Compiler disabled.\n" +
    "Run: " +
    installCommand +
    " @vitejs/plugin-react@latest"
  );
}
