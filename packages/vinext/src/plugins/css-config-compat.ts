import type { UserConfig } from "vite";
import type { ResolvedNextConfig } from "../config/next-config.js";
import { isRecord } from "../utils/is-record.js";
import {
  inspectPostcssConfig,
  isTailwindPostcssPluginValue,
  resolvePostcssPlugin,
  type PostcssAcceptedPlugin,
} from "./postcss.js";

type ExplicitPostcssConfig = {
  plugins: PostcssAcceptedPlugin[];
};

type CssConfigCompatibilityInput = {
  projectRoot: string;
  viteConfig: UserConfig;
  nextConfig: ResolvedNextConfig;
  configuredPlugins: unknown[];
};

const TAILWIND_POSTCSS_PLUGIN = "@tailwindcss/postcss";

function isNamedPlugin(value: unknown, name: string): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    "name" in value &&
    typeof value.name === "string" &&
    (value.name === name || value.name.startsWith(`${name}:`))
  );
}

function hasUserTailwindVitePlugin(plugins: unknown[]): boolean {
  return plugins.some((plugin) => isNamedPlugin(plugin, "@tailwindcss/vite"));
}

function getExplicitPostcssPlugins(viteConfig: UserConfig): readonly unknown[] {
  const postcss = viteConfig.css?.postcss;
  if (!isRecord(postcss) || !Array.isArray(postcss.plugins)) return [];
  return postcss.plugins;
}

function shouldInspectProjectPostcssConfig(viteConfig: UserConfig): boolean {
  return !viteConfig.css?.postcss;
}

function prependPostcssPlugin(
  base: ExplicitPostcssConfig | undefined,
  plugin: PostcssAcceptedPlugin,
): ExplicitPostcssConfig {
  return {
    plugins: base ? [plugin, ...base.plugins] : [plugin],
  };
}

export async function resolveCssConfigCompatibility({
  projectRoot,
  viteConfig,
  nextConfig,
  configuredPlugins,
}: CssConfigCompatibilityInput): Promise<Pick<UserConfig, "css">> {
  let postcssOverride: ExplicitPostcssConfig | undefined;
  let hasTailwindPostcssConfig = getExplicitPostcssPlugins(viteConfig).some(
    isTailwindPostcssPluginValue,
  );
  let projectPostcssConfig: Awaited<ReturnType<typeof inspectPostcssConfig>> | undefined;

  if (shouldInspectProjectPostcssConfig(viteConfig)) {
    projectPostcssConfig = await inspectPostcssConfig(projectRoot);
    hasTailwindPostcssConfig =
      hasTailwindPostcssConfig || (projectPostcssConfig?.hasTailwindPlugin ?? false);
    if (projectPostcssConfig?.shouldInjectIntoVite) {
      postcssOverride = await projectPostcssConfig.postcss;
    }
  }

  if (
    nextConfig.tailwindTurbopackCssLoader &&
    !hasTailwindPostcssConfig &&
    !hasUserTailwindVitePlugin(configuredPlugins)
  ) {
    if (viteConfig.css?.postcss) {
      console.warn(
        '[vinext] next.config turbopack.rules uses "@tailwindcss/webpack", but vite.config already defines css.postcss. ' +
          'vinext will leave the explicit Vite PostCSS config unchanged; add "@tailwindcss/postcss" there or register "@tailwindcss/vite" manually.',
      );
    } else if (projectPostcssConfig?.isOpaqueConfig) {
      console.warn(
        '[vinext] next.config turbopack.rules uses "@tailwindcss/webpack", but an existing PostCSS config could not be safely merged. ' +
          'vinext will leave the PostCSS config unchanged; add "@tailwindcss/postcss" there or register "@tailwindcss/vite" manually.',
      );
    } else {
      let tailwindPostcssPlugin: PostcssAcceptedPlugin;
      try {
        tailwindPostcssPlugin = await resolvePostcssPlugin(
          projectRoot,
          TAILWIND_POSTCSS_PLUGIN,
          {},
        );
      } catch (cause) {
        throw new Error(
          '[vinext] next.config turbopack.rules uses "@tailwindcss/webpack", but vinext needs "@tailwindcss/postcss" to translate that rule into Vite CSS processing. ' +
            'Install "@tailwindcss/postcss", configure it in PostCSS, or register "@tailwindcss/vite" in vite.config.ts.',
          { cause },
        );
      }

      const existingPostcss =
        postcssOverride ??
        (projectPostcssConfig?.postcss ? await projectPostcssConfig.postcss : undefined);
      postcssOverride = prependPostcssPlugin(existingPostcss, tailwindPostcssPlugin);
    }
  }

  return postcssOverride ? { css: { postcss: postcssOverride } } : {};
}
