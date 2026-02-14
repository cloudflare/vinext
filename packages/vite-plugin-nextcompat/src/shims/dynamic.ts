/**
 * next/dynamic shim
 *
 * Provides React.lazy-based dynamic imports with SSR support.
 * Mirrors the next/dynamic API: dynamic(() => import('./Component'))
 */
import { lazy, type ComponentType } from "react";

interface DynamicOptions {
  loading?: ComponentType;
  ssr?: boolean;
}

type Loader<P> = () => Promise<{ default: ComponentType<P> } | ComponentType<P>>;

function dynamic<P extends object>(
  loader: Loader<P>,
  _options?: DynamicOptions,
): ComponentType<P> {
  return lazy(async () => {
    const mod = await loader();
    if ("default" in mod) {
      return mod as { default: ComponentType<P> };
    }
    return { default: mod as ComponentType<P> };
  });
}

export default dynamic;
