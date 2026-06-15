import { builtinModules } from "node:module";
import { createIdResolver, type Plugin, type ResolvedConfig, type Rollup } from "vite";

export type RuntimeExportCondition = "edge-light" | "edge-light-react-server" | "middleware";

const RUNTIME_CONDITION_QUERY = "__vinext_runtime_condition";
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

export function withRuntimeExportCondition(
  specifier: string,
  condition: RuntimeExportCondition,
): string {
  const separator = specifier.includes("?") ? "&" : "?";
  return `${specifier}${separator}${RUNTIME_CONDITION_QUERY}=${condition}`;
}

function readRuntimeExportCondition(specifier: string | undefined): RuntimeExportCondition | null {
  if (!specifier) return null;
  const queryIndex = specifier.indexOf("?");
  if (queryIndex === -1) return null;
  const value = new URLSearchParams(specifier.slice(queryIndex + 1)).get(RUNTIME_CONDITION_QUERY);
  return value === "edge-light" || value === "edge-light-react-server" || value === "middleware"
    ? value
    : null;
}

function stripRuntimeExportCondition(specifier: string): string {
  const queryIndex = specifier.indexOf("?");
  if (queryIndex === -1) return specifier;

  const pathname = specifier.slice(0, queryIndex);
  const params = new URLSearchParams(specifier.slice(queryIndex + 1));
  params.delete(RUNTIME_CONDITION_QUERY);
  const query = params.toString();
  return query.length > 0 ? `${pathname}?${query}` : pathname;
}

function isVirtualId(specifier: string): boolean {
  return specifier.startsWith("virtual:") || specifier.startsWith("\0");
}

function isUnhandledScheme(specifier: string): boolean {
  const schemeSpecifier = specifier.startsWith("\0") ? specifier.slice(1) : specifier;
  return /^[a-z][a-z+.-]*:/.test(schemeSpecifier) && !isVirtualId(specifier);
}

function normalizeResolvedId(
  resolved: string | Rollup.PartialResolvedId,
): Rollup.PartialResolvedId {
  return typeof resolved === "string" ? { id: resolved } : resolved;
}

function runtimeConditions(
  config: ResolvedConfig,
  environmentConditions: readonly string[],
  condition: RuntimeExportCondition,
): string[] {
  const conditions = new Set<string>();
  if (condition !== "edge-light") conditions.add("react-server");
  conditions.add("edge-light");
  conditions.add("browser");

  for (const value of environmentConditions) {
    if (value !== "worker" && value !== "workerd" && value !== "node" && value !== "node-addons") {
      conditions.add(value);
    }
  }

  if (config.isProduction) conditions.add("production");
  else conditions.add("development");
  return [...conditions];
}

export function runtimeExportConditionsPlugin(): Plugin {
  let config: ResolvedConfig;
  const resolvers = new Map<string, ReturnType<typeof createIdResolver>>();

  return {
    name: "vinext:runtime-export-conditions",
    enforce: "pre",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    async resolveId(source, importer, options) {
      const environment = this.environment;
      const condition = readRuntimeExportCondition(source) ?? readRuntimeExportCondition(importer);
      if (condition === null) return null;

      const cleanSource = stripRuntimeExportCondition(source);
      const cleanImporter = importer ? stripRuntimeExportCondition(importer) : undefined;
      if (environment.config.consumer === "client") {
        return this.resolve(cleanSource, cleanImporter, {
          ...options,
          skipSelf: true,
        });
      }

      if (
        NODE_BUILTINS.has(cleanSource) ||
        isUnhandledScheme(cleanSource) ||
        isVirtualId(cleanSource) ||
        cleanSource.includes("?")
      ) {
        return null;
      }

      const conditions = runtimeConditions(
        config,
        environment.config.resolve.conditions,
        condition,
      );
      const isRequire = options.kind === "require-call";
      const resolverKey = `${condition}:${isRequire ? "require" : "import"}:${conditions.join("\0")}`;
      let resolver = resolvers.get(resolverKey);
      if (!resolver) {
        resolver = createIdResolver(config, { conditions, isRequire });
        resolvers.set(resolverKey, resolver);
      }
      const customResolved = await resolver(environment, cleanSource, cleanImporter);
      const pluginResolved = await this.resolve(cleanSource, cleanImporter, {
        ...options,
        skipSelf: true,
      });
      if (!customResolved && !pluginResolved) return null;

      const pluginOwnsModule =
        pluginResolved && (isVirtualId(pluginResolved.id) || pluginResolved.id.includes("?"));
      const resolved = normalizeResolvedId(
        pluginOwnsModule ? pluginResolved : (customResolved ?? pluginResolved!),
      );
      const metadata = pluginResolved ? { ...pluginResolved, ...resolved } : resolved;
      if (metadata.external) return metadata;

      const resolvedId = resolved.id;
      if (isVirtualId(resolvedId) || resolvedId.includes("?")) return metadata;
      if (
        !resolvedId.startsWith("\0") &&
        !resolvedId.startsWith("/") &&
        !/^[A-Za-z]:[\\/]/.test(resolvedId)
      ) {
        return metadata;
      }

      return {
        ...metadata,
        id: withRuntimeExportCondition(resolvedId, condition),
      };
    },
  };
}
