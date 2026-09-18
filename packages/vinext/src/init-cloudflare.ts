import fs from "node:fs";
import path from "pathslash";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import MagicString from "magic-string";
import type { ESTree } from "vite";
import type { CloudflareInitOptions } from "./init-platform.js";
import { forEachAstChild, unwrapExpression } from "./plugins/ast-utils.js";
import { detectProject } from "./utils/project.js";
import { isUnknownRecord } from "./utils/record.js";

const require = createRequire(import.meta.url);

export type CloudflareProjectInfo = {
  root: string;
  projectName: string;
  isAppRouter: boolean;
  hasISR: boolean;
  hasMDX: boolean;
  hasTailwindV4: boolean;
  nativeModulesToStub: string[];
};

const DEFAULT_CLOUDFLARE_INIT_OPTIONS: CloudflareInitOptions = {
  dataCache: "none",
  cdnCache: "none",
  imageOptimization: "cloudflare-images",
};
const DEFAULT_VERSION_METADATA_BINDING = "CF_VERSION_METADATA";
const RESPONSE_STORE_WRANGLER_CONFIG = "wrangler.response-store.jsonc";

const RESPONSE_STORE_BINDING = "RESPONSE_STORE";
const RESPONSE_STORE_ENTRYPOINT = "ResponseStoreService";
const RESPONSE_STORE_MAIN = "./node_modules/@cloudflare/workers-response-store/dist/service.js";
const CACHE_BODIES_BINDING = "CACHE_BODIES";
const CACHE_METADATA_BINDING = "CACHE_METADATA";
const CACHE_METADATA_CLASS = "CacheMetadata";
const CACHE_METADATA_EXPORT = { type: "durable-object", storage: "sqlite" } as const;
const CTX_EXPORTS_DEFAULT_DATE = "2025-11-17";

export type CloudflarePlatformSetupContext = {
  root: string;
  isAppRouter: boolean;
  existingViteConfigPath?: string;
  packageManager?: string;
  prerender?: boolean;
  today?: string;
};

export type CloudflarePlatformSetupResult = {
  generatedViteConfig: boolean;
  skippedViteConfig: boolean;
  generatedPlatformFiles: string[];
  nextSteps: string[];
};

export function validateCloudflarePlatformSetup(
  context: CloudflarePlatformSetupContext,
  cloudflare: CloudflareInitOptions,
): void {
  const tomlPath = path.join(context.root, "wrangler.toml");
  if (fs.existsSync(tomlPath)) {
    throw new Error(
      "wrangler.toml is not supported by vinext init. Convert it to wrangler.jsonc and rerun.",
    );
  }

  const projectInfo = detectProject(context.root);
  const wranglerPath = ["wrangler.jsonc", "wrangler.json"]
    .map((fileName) => path.join(context.root, fileName))
    .find((candidate) => fs.existsSync(candidate));
  const wranglerCode = wranglerPath ? fs.readFileSync(wranglerPath, "utf-8") : undefined;
  if (
    !wranglerCode &&
    cloudflare.cdnCache === "response-store" &&
    (cloudflare.responseStoreMode ?? "service-binding") === "service-binding" &&
    fs.existsSync(path.join(context.root, RESPONSE_STORE_WRANGLER_CONFIG))
  ) {
    readResponseStoreServiceName(context.root, {});
  }
  const updatedWranglerCode = wranglerCode
    ? updateWranglerConfigForCloudflare(wranglerCode, cloudflare, { root: context.root })
    : undefined;
  const imagesBinding = updatedWranglerCode
    ? getWranglerImagesBinding(updatedWranglerCode)
    : "IMAGES";
  const versionMetadataBinding = updatedWranglerCode
    ? getWranglerVersionMetadataBinding(updatedWranglerCode)
    : DEFAULT_VERSION_METADATA_BINDING;

  if (context.existingViteConfigPath) {
    updateViteConfigForCloudflare(
      context.existingViteConfigPath,
      fs.readFileSync(context.existingViteConfigPath, "utf-8"),
      {
        isAppRouter: context.isAppRouter,
        hasTailwindV4: projectInfo.hasTailwindV4,
        nativeModulesToStub: projectInfo.nativeModulesToStub,
        cache: cloudflare,
        imagesBinding,
        versionMetadataBinding,
        prerender: context.prerender,
      },
    );
  }
}

export function setupCloudflarePlatform(
  context: CloudflarePlatformSetupContext,
  cloudflare: CloudflareInitOptions,
): CloudflarePlatformSetupResult {
  const projectInfo = detectProject(context.root);
  const wranglerPath = ["wrangler.jsonc", "wrangler.json"]
    .map((fileName) => path.join(context.root, fileName))
    .find((candidate) => fs.existsSync(candidate));
  const wranglerCode = wranglerPath ? fs.readFileSync(wranglerPath, "utf-8") : undefined;
  const updatedWranglerCode = wranglerCode
    ? updateWranglerConfigForCloudflare(wranglerCode, cloudflare, { root: context.root })
    : undefined;
  const imagesBinding = updatedWranglerCode
    ? getWranglerImagesBinding(updatedWranglerCode)
    : "IMAGES";
  const versionMetadataBinding = updatedWranglerCode
    ? getWranglerVersionMetadataBinding(updatedWranglerCode)
    : DEFAULT_VERSION_METADATA_BINDING;

  let generatedViteConfig = false;
  let skippedViteConfig = false;
  if (context.existingViteConfigPath) {
    const currentConfig = fs.readFileSync(context.existingViteConfigPath, "utf-8");
    const updatedConfig = updateViteConfigForCloudflare(
      context.existingViteConfigPath,
      currentConfig,
      {
        isAppRouter: context.isAppRouter,
        hasTailwindV4: projectInfo.hasTailwindV4,
        nativeModulesToStub: projectInfo.nativeModulesToStub,
        cache: cloudflare,
        imagesBinding,
        versionMetadataBinding,
        prerender: context.prerender,
      },
    );
    if (updatedConfig !== currentConfig) {
      fs.writeFileSync(context.existingViteConfigPath, updatedConfig, "utf-8");
      generatedViteConfig = true;
    } else {
      skippedViteConfig = true;
    }
  } else {
    const configContent = context.isAppRouter
      ? generateAppRouterViteConfig(
          projectInfo,
          cloudflare,
          imagesBinding,
          context.prerender,
          versionMetadataBinding,
        )
      : generatePagesRouterViteConfig(
          projectInfo,
          cloudflare,
          imagesBinding,
          context.prerender,
          versionMetadataBinding,
        );
    fs.writeFileSync(path.join(context.root, "vite.config.ts"), configContent, "utf-8");
    generatedViteConfig = true;
  }

  const generatedPlatformFiles: string[] = [];
  if (!wranglerPath) {
    fs.writeFileSync(
      path.join(context.root, "wrangler.jsonc"),
      generateWranglerConfig(projectInfo, cloudflare, context.today),
      "utf-8",
    );
    generatedPlatformFiles.push("wrangler.jsonc");
  } else if (wranglerCode && updatedWranglerCode) {
    if (updatedWranglerCode !== wranglerCode) {
      fs.writeFileSync(wranglerPath, updatedWranglerCode, "utf-8");
      generatedPlatformFiles.push(path.basename(wranglerPath));
    }
  }

  const finalWranglerPath = wranglerPath ?? path.join(context.root, "wrangler.jsonc");
  const finalWranglerFileName = path.basename(finalWranglerPath);
  if (
    cloudflare.cdnCache === "response-store" &&
    (cloudflare.responseStoreMode ?? "service-binding") === "service-binding"
  ) {
    const responseStorePath = path.join(
      path.dirname(finalWranglerPath),
      RESPONSE_STORE_WRANGLER_CONFIG,
    );
    if (!fs.existsSync(responseStorePath)) {
      fs.writeFileSync(
        responseStorePath,
        generateResponseStoreWranglerConfig(
          fs.readFileSync(finalWranglerPath, "utf-8"),
          context.root,
        ),
        "utf-8",
      );
      generatedPlatformFiles.push(
        path.relative(context.root, responseStorePath) || RESPONSE_STORE_WRANGLER_CONFIG,
      );
    }
  }
  const finalWranglerConfig = JSON.parse(
    stripJsonComments(fs.readFileSync(finalWranglerPath, "utf-8")),
  ) as { kv_namespaces?: Array<{ binding?: unknown; id?: unknown }> };
  const kvBinding = finalWranglerConfig.kv_namespaces?.find(
    (namespace) => namespace.binding === "VINEXT_KV_CACHE",
  );
  const needsKvNamespaceId =
    cloudflare.dataCache === "kv" &&
    (!kvBinding ||
      typeof kvBinding.id !== "string" ||
      kvBinding.id.length === 0 ||
      kvBinding.id === "<your-kv-namespace-id>");

  const nextSteps: string[] = [];
  if (
    cloudflare.cdnCache === "response-store" &&
    (cloudflare.responseStoreMode ?? "service-binding") === "service-binding"
  ) {
    nextSteps.push(
      "Deploy Workers Response Store before deploying the application:",
      `   ${context.packageManager ?? "npm"} run deploy:response-store`,
    );
  }
  if (needsKvNamespaceId) {
    nextSteps.push(
      "Cloudflare setup is incomplete until you finish KV configuration:",
      "1. Create the KV namespace:",
      "   npx wrangler kv namespace create VINEXT_KV_CACHE",
      `2. Copy the returned namespace ID into the VINEXT_KV_CACHE entry in ${finalWranglerFileName}:`,
      '   Set its "id" value, replacing "<your-kv-namespace-id>" if present.',
    );
  }

  return {
    generatedViteConfig,
    skippedViteConfig,
    generatedPlatformFiles,
    nextSteps,
  };
}

/**
 * `main` is what makes a Wrangler config a Worker rather than a static-assets
 * project. A custom `worker/index.*` wins when present; otherwise the
 * router-selected entry resolves to the App or Pages Router handler at build
 * time.
 */
function resolveWorkerEntry(root: string): string {
  if (fs.existsSync(path.join(root, "worker", "index.ts"))) return "./worker/index.ts";
  if (fs.existsSync(path.join(root, "worker", "index.js"))) return "./worker/index.js";
  return "vinext/server/fetch-handler";
}

// Cloudflare deployment scaffolding belongs to `vinext init`.
export function generateWranglerConfig(
  info: CloudflareProjectInfo,
  options: CloudflareInitOptions = DEFAULT_CLOUDFLARE_INIT_OPTIONS,
  today = new Date().toISOString().split("T")[0],
): string {
  const workerEntry = resolveWorkerEntry(info.root);

  const config: Record<string, unknown> = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: info.projectName,
    compatibility_date: today,
    compatibility_flags: ["nodejs_compat"],
    main: workerEntry,
    assets: {
      directory: "dist/client",
      not_found_handling: "none",
      binding: "ASSETS",
    },
  };

  if (options.cdnCache === "workers-cache") {
    config.cache = { enabled: true };
    config.version_metadata = { binding: DEFAULT_VERSION_METADATA_BINDING };
  }

  if (options.imageOptimization === "cloudflare-images") {
    config.images = { binding: "IMAGES" };
  }

  if (options.dataCache === "kv") {
    config.kv_namespaces = [
      {
        binding: "VINEXT_KV_CACHE",
        id: "<your-kv-namespace-id>",
      },
    ];
  }

  const code = `${JSON.stringify(config, null, 2)}\n`;
  if (options.cdnCache !== "response-store") return code;

  const configured = configureResponseStoreWrangler(
    code,
    config,
    options.responseStoreMode ?? "service-binding",
    info.root,
  );
  return `${JSON.stringify(JSON.parse(configured), null, 2)}\n`;
}

function stripJsonComments(code: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < code.length; index++) {
    const char = code[index];
    const next = code[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < code.length && code[index] !== "\n") index++;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < code.length && !(code[index] === "*" && code[index + 1] === "/")) {
        output += code[index] === "\n" ? "\n" : " ";
        index++;
      }
      index++;
      continue;
    }
    output += char;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

function findTopLevelJsonProperty(
  code: string,
  name: string,
): { valueStart: number; valueEnd: number } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < code.length; index++) {
    const char = code[index];
    const next = code[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    if (char === '"') {
      inString = true;
      let value = "";
      index++;
      for (; index < code.length; index++) {
        const stringChar = code[index];
        if (stringChar === "\\") {
          value += stringChar + (code[++index] ?? "");
        } else if (stringChar === '"') {
          inString = false;
          break;
        } else value += stringChar;
      }
      if (depth !== 1 || value !== name) continue;
      let cursor = index + 1;
      while (/\s/.test(code[cursor] ?? "")) cursor++;
      if (code[cursor] !== ":") continue;
      cursor++;
      while (/\s/.test(code[cursor] ?? "")) cursor++;
      const valueStart = cursor;
      let valueDepth = 0;
      let valueString = false;
      let valueEscaped = false;
      let valueLineComment = false;
      let valueBlockComment = false;
      for (; cursor < code.length; cursor++) {
        const valueChar = code[cursor];
        const valueNext = code[cursor + 1];
        if (valueLineComment) {
          if (valueChar === "\n") valueLineComment = false;
          continue;
        }
        if (valueBlockComment) {
          if (valueChar === "*" && valueNext === "/") {
            valueBlockComment = false;
            cursor++;
          }
          continue;
        }
        if (valueString) {
          if (valueEscaped) valueEscaped = false;
          else if (valueChar === "\\") valueEscaped = true;
          else if (valueChar === '"') valueString = false;
          continue;
        }
        if (valueChar === "/" && valueNext === "/") {
          valueLineComment = true;
          cursor++;
        } else if (valueChar === "/" && valueNext === "*") {
          valueBlockComment = true;
          cursor++;
        } else if (valueChar === '"') valueString = true;
        else if (valueChar === "{" || valueChar === "[") valueDepth++;
        else if (valueChar === "}" || valueChar === "]") {
          if (valueDepth === 0) return { valueStart, valueEnd: cursor };
          valueDepth--;
          if (valueDepth === 0) return { valueStart, valueEnd: cursor + 1 };
        } else if (valueChar === "," && valueDepth === 0) {
          return { valueStart, valueEnd: cursor };
        }
      }
      return { valueStart, valueEnd: cursor };
    }
    if (char === "{") depth++;
    else if (char === "}") depth--;
  }
  return null;
}

function appendTopLevelJsonProperty(code: string, property: string): string {
  const closing = code.lastIndexOf("}");
  if (closing < 0) throw new Error("Could not find the root object in Wrangler config.");
  const before = code.slice(0, closing);
  const structuralBefore = stripJsonComments(before);
  const needsComma = !/,\s*$/.test(structuralBefore) && !/{\s*$/.test(structuralBefore);
  return `${before}${needsComma ? "," : ""}\n${property}\n${code.slice(closing)}`;
}

function setTopLevelJsonProperty(code: string, name: string, value: unknown): string {
  const property = findTopLevelJsonProperty(code, name);
  const serialized = JSON.stringify(value);
  if (!property) {
    return appendTopLevelJsonProperty(code, `  ${JSON.stringify(name)}: ${serialized}`);
  }
  return `${code.slice(0, property.valueStart)}${serialized}${code.slice(property.valueEnd)}`;
}

function compactResourceName(name: string, suffix: string, maxLength: number): string {
  const fullName = `${name}${suffix}`;
  if (fullName.length <= maxLength) return fullName;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, maxLength - suffix.length - hash.length - 1)}-${hash}${suffix}`;
}

function isCacheMetadataExport(value: unknown): boolean {
  return (
    isUnknownRecord(value) &&
    value.type === CACHE_METADATA_EXPORT.type &&
    value.storage === CACHE_METADATA_EXPORT.storage
  );
}

function readResponseStoreServiceName(root: string, appConfig: Record<string, unknown>): string {
  const responseStorePath = path.join(root, RESPONSE_STORE_WRANGLER_CONFIG);
  if (fs.existsSync(responseStorePath)) {
    let responseStoreConfig: unknown;
    try {
      responseStoreConfig = JSON.parse(
        stripJsonComments(fs.readFileSync(responseStorePath, "utf8")),
      );
    } catch (cause) {
      throw new Error(`Could not parse ${RESPONSE_STORE_WRANGLER_CONFIG}.`, { cause });
    }
    if (
      !isUnknownRecord(responseStoreConfig) ||
      typeof responseStoreConfig.name !== "string" ||
      responseStoreConfig.name.length === 0
    ) {
      throw new Error(`${RESPONSE_STORE_WRANGLER_CONFIG} must contain a Worker name.`);
    }
    if (responseStoreConfig.main !== RESPONSE_STORE_MAIN) {
      throw new Error(
        `${RESPONSE_STORE_WRANGLER_CONFIG} already exists but does not use @cloudflare/workers-response-store.`,
      );
    }
    const responseStoreExport = isUnknownRecord(responseStoreConfig.exports)
      ? responseStoreConfig.exports.ResponseStoreBinding
      : undefined;
    const cacheMetadataExport = isUnknownRecord(responseStoreConfig.exports)
      ? responseStoreConfig.exports[CACHE_METADATA_CLASS]
      : undefined;
    const hasCacheBodies =
      Array.isArray(responseStoreConfig.r2_buckets) &&
      responseStoreConfig.r2_buckets.some(
        (binding) => isUnknownRecord(binding) && binding.binding === CACHE_BODIES_BINDING,
      );
    const durableBindings = isUnknownRecord(responseStoreConfig.durable_objects)
      ? responseStoreConfig.durable_objects.bindings
      : undefined;
    const hasCacheMetadata =
      Array.isArray(durableBindings) &&
      durableBindings.some(
        (binding) =>
          isUnknownRecord(binding) &&
          binding.name === CACHE_METADATA_BINDING &&
          binding.class_name === CACHE_METADATA_CLASS &&
          binding.script_name === undefined,
      );
    const hasNoMigrations =
      responseStoreConfig.migrations === undefined ||
      (Array.isArray(responseStoreConfig.migrations) &&
        responseStoreConfig.migrations.length === 0);
    if (
      !isUnknownRecord(responseStoreConfig.cache) ||
      responseStoreConfig.cache.enabled !== true ||
      !isUnknownRecord(responseStoreExport) ||
      !isUnknownRecord(responseStoreExport.cache) ||
      responseStoreExport.cache.enabled !== true ||
      !hasCacheBodies ||
      !hasCacheMetadata ||
      !isCacheMetadataExport(cacheMetadataExport) ||
      !hasNoMigrations
    ) {
      throw new Error(
        `${RESPONSE_STORE_WRANGLER_CONFIG} is missing required Response Store bindings.`,
      );
    }
    const compatibilityFlags = responseStoreConfig.compatibility_flags;
    if (
      compatibilityFlags !== undefined &&
      (!Array.isArray(compatibilityFlags) ||
        compatibilityFlags.some((flag) => typeof flag !== "string"))
    ) {
      throw new Error(`${RESPONSE_STORE_WRANGLER_CONFIG} has invalid compatibility flags.`);
    }
    const flags = (compatibilityFlags ?? []) as string[];
    if (
      flags.includes("disable_ctx_exports") ||
      ((typeof responseStoreConfig.compatibility_date !== "string" ||
        responseStoreConfig.compatibility_date < CTX_EXPORTS_DEFAULT_DATE) &&
        !flags.includes("enable_ctx_exports"))
    ) {
      throw new Error(
        `${RESPONSE_STORE_WRANGLER_CONFIG} must enable ctx.exports with a compatibility date on or after ${CTX_EXPORTS_DEFAULT_DATE}, or the enable_ctx_exports compatibility flag.`,
      );
    }
    return responseStoreConfig.name;
  }

  if (Array.isArray(appConfig.services)) {
    const binding = appConfig.services.find(
      (service) => isUnknownRecord(service) && service.binding === RESPONSE_STORE_BINDING,
    );
    if (
      isUnknownRecord(binding) &&
      typeof binding.service === "string" &&
      binding.service.length > 0
    ) {
      return binding.service;
    }
  }

  const appName =
    typeof appConfig.name === "string" && appConfig.name.length > 0
      ? appConfig.name
      : detectProject(root).projectName;
  return compactResourceName(appName, "-response-store", 63);
}

function configureResponseStoreWrangler(
  code: string,
  config: Record<string, unknown>,
  mode: "self-contained" | "service-binding",
  root: string,
): string {
  const flags = Array.isArray(config.compatibility_flags)
    ? config.compatibility_flags.filter((flag): flag is string => typeof flag === "string")
    : [];
  if (flags.includes("disable_ctx_exports")) {
    throw new Error("Workers Response Store requires ctx.exports to be enabled.");
  }
  if (
    (typeof config.compatibility_date !== "string" ||
      config.compatibility_date < CTX_EXPORTS_DEFAULT_DATE) &&
    !flags.includes("enable_ctx_exports")
  ) {
    code = setTopLevelJsonProperty(code, "compatibility_flags", [...flags, "enable_ctx_exports"]);
  }

  const versionMetadata = config.version_metadata;
  if (
    versionMetadata !== undefined &&
    (!isUnknownRecord(versionMetadata) ||
      versionMetadata.binding !== DEFAULT_VERSION_METADATA_BINDING)
  ) {
    throw new Error(
      `Workers Response Store requires version_metadata.binding to be ${JSON.stringify(DEFAULT_VERSION_METADATA_BINDING)}.`,
    );
  }
  code = setTopLevelJsonProperty(code, "version_metadata", {
    binding: DEFAULT_VERSION_METADATA_BINDING,
  });

  const cache = config.cache;
  if (cache !== undefined && !isUnknownRecord(cache)) {
    throw new Error("The existing Wrangler config has an invalid cache value.");
  }
  code = setTopLevelJsonProperty(code, "cache", {
    ...cache,
    enabled: mode === "self-contained",
  });

  const exportsConfig = config.exports;
  if (exportsConfig !== undefined && !isUnknownRecord(exportsConfig)) {
    throw new Error("The existing Wrangler config has an invalid exports value.");
  }
  const workerExports = { ...exportsConfig } as Record<string, unknown>;
  const cacheMetadataExport = workerExports[CACHE_METADATA_CLASS];
  const hasCacheMetadataExport = isCacheMetadataExport(cacheMetadataExport);
  let updateWorkerExports = mode === "self-contained";

  const services = config.services;
  if (services !== undefined && !Array.isArray(services)) {
    throw new Error("The existing Wrangler config has an invalid services value.");
  }
  const existingServices = (services ?? []) as unknown[];
  if (existingServices.some((service) => !isUnknownRecord(service))) {
    throw new Error("The existing Wrangler config has an invalid service binding.");
  }
  const responseStoreService = existingServices.find(
    (service) => (service as Record<string, unknown>).binding === RESPONSE_STORE_BINDING,
  ) as Record<string, unknown> | undefined;
  if (responseStoreService && responseStoreService.entrypoint !== RESPONSE_STORE_ENTRYPOINT) {
    throw new Error(`The ${RESPONSE_STORE_BINDING} service binding uses a different entrypoint.`);
  }

  if (mode === "service-binding") {
    const responseStoreExport = workerExports.ResponseStoreBinding;
    const hasSelfContainedResponseStore =
      isUnknownRecord(responseStoreExport) &&
      responseStoreExport.type === "worker" &&
      isUnknownRecord(responseStoreExport.cache) &&
      responseStoreExport.cache.enabled === true;
    if (responseStoreExport !== undefined && !hasSelfContainedResponseStore) {
      throw new Error(
        "The existing ResponseStoreBinding export conflicts with Workers Response Store.",
      );
    }
    if (
      hasSelfContainedResponseStore &&
      cacheMetadataExport !== undefined &&
      !hasCacheMetadataExport
    ) {
      throw new Error(
        `The existing ${CACHE_METADATA_CLASS} export conflicts with Workers Response Store.`,
      );
    }
    const hasCacheBodies =
      Array.isArray(config.r2_buckets) &&
      config.r2_buckets.some(
        (bucket) => isUnknownRecord(bucket) && bucket.binding === CACHE_BODIES_BINDING,
      );
    const durableBindings = isUnknownRecord(config.durable_objects)
      ? config.durable_objects.bindings
      : undefined;
    const hasCacheMetadata =
      Array.isArray(durableBindings) &&
      durableBindings.some(
        (binding) => isUnknownRecord(binding) && binding.name === CACHE_METADATA_BINDING,
      );
    if (!hasSelfContainedResponseStore && hasCacheBodies) {
      throw new Error(
        `${CACHE_BODIES_BINDING} is already used by an application-owned R2 binding.`,
      );
    }
    if (!hasSelfContainedResponseStore && hasCacheMetadata) {
      throw new Error(
        `${CACHE_METADATA_BINDING} is already used by an application-owned Durable Object binding.`,
      );
    }

    const serviceName = readResponseStoreServiceName(root, config);
    code = setTopLevelJsonProperty(code, "services", [
      ...existingServices.filter(
        (service) => (service as Record<string, unknown>).binding !== RESPONSE_STORE_BINDING,
      ),
      {
        ...responseStoreService,
        binding: RESPONSE_STORE_BINDING,
        service: serviceName,
        entrypoint: RESPONSE_STORE_ENTRYPOINT,
      },
    ]);
    updateWorkerExports = hasSelfContainedResponseStore;
    delete workerExports.ResponseStoreBinding;
    if (hasSelfContainedResponseStore) delete workerExports[CACHE_METADATA_CLASS];

    if (Array.isArray(config.r2_buckets)) {
      code = setTopLevelJsonProperty(
        code,
        "r2_buckets",
        config.r2_buckets.filter(
          (bucket) => !isUnknownRecord(bucket) || bucket.binding !== CACHE_BODIES_BINDING,
        ),
      );
    }
    if (isUnknownRecord(config.durable_objects) && Array.isArray(config.durable_objects.bindings)) {
      code = setTopLevelJsonProperty(code, "durable_objects", {
        ...config.durable_objects,
        bindings: config.durable_objects.bindings.filter(
          (binding) => !isUnknownRecord(binding) || binding.name !== CACHE_METADATA_BINDING,
        ),
      });
    }
  } else {
    const defaultExport = workerExports.default;
    if (defaultExport !== undefined && !isUnknownRecord(defaultExport)) {
      throw new Error("The existing Wrangler config has an invalid default export.");
    }
    workerExports.default = {
      ...defaultExport,
      type: "worker",
      cache: { enabled: false },
    };
    if (responseStoreService) {
      code = setTopLevelJsonProperty(
        code,
        "services",
        existingServices.filter(
          (service) => (service as Record<string, unknown>).binding !== RESPONSE_STORE_BINDING,
        ),
      );
    }
    for (const [name, value] of Object.entries(workerExports)) {
      if (!isUnknownRecord(value)) {
        throw new Error(`The existing Wrangler config has an invalid ${name} export.`);
      }
      if (value.type === "worker" && value.cache === undefined) {
        workerExports[name] = { ...value, cache: { enabled: false } };
      }
    }
    const responseStoreExport = workerExports.ResponseStoreBinding;
    if (responseStoreExport !== undefined && !isUnknownRecord(responseStoreExport)) {
      throw new Error("The existing Wrangler config has an invalid ResponseStoreBinding export.");
    }
    workerExports.ResponseStoreBinding = {
      ...responseStoreExport,
      type: "worker",
      cache: { enabled: true },
    };
    if (cacheMetadataExport !== undefined && !hasCacheMetadataExport) {
      throw new Error(
        `The existing ${CACHE_METADATA_CLASS} export conflicts with Workers Response Store.`,
      );
    }
    workerExports[CACHE_METADATA_CLASS] = CACHE_METADATA_EXPORT;

    const r2Buckets = config.r2_buckets;
    if (r2Buckets !== undefined && !Array.isArray(r2Buckets)) {
      throw new Error("The existing Wrangler config has an invalid r2_buckets value.");
    }
    const existingBuckets = (r2Buckets ?? []) as unknown[];
    if (existingBuckets.some((bucket) => !isUnknownRecord(bucket))) {
      throw new Error("The existing Wrangler config has an invalid R2 binding.");
    }
    if (
      !existingBuckets.some(
        (bucket) => (bucket as Record<string, unknown>).binding === CACHE_BODIES_BINDING,
      )
    ) {
      const appName =
        typeof config.name === "string" && config.name.length > 0
          ? config.name
          : detectProject(root).projectName;
      code = setTopLevelJsonProperty(code, "r2_buckets", [
        ...existingBuckets,
        {
          binding: CACHE_BODIES_BINDING,
          bucket_name: compactResourceName(appName, "-response-store-cache-bodies", 63),
        },
      ]);
    }

    const durableObjects = config.durable_objects;
    if (durableObjects !== undefined && !isUnknownRecord(durableObjects)) {
      throw new Error("The existing Wrangler config has an invalid durable_objects value.");
    }
    const durableBindings = durableObjects?.bindings;
    if (durableBindings !== undefined && !Array.isArray(durableBindings)) {
      throw new Error("The existing Wrangler config has invalid Durable Object bindings.");
    }
    const existingDurableBindings = (durableBindings ?? []) as unknown[];
    if (existingDurableBindings.some((binding) => !isUnknownRecord(binding))) {
      throw new Error("The existing Wrangler config has an invalid Durable Object binding.");
    }
    const existingMetadataBinding = existingDurableBindings.find(
      (binding) => (binding as Record<string, unknown>).name === CACHE_METADATA_BINDING,
    ) as Record<string, unknown> | undefined;
    if (
      existingMetadataBinding &&
      (existingMetadataBinding.class_name !== CACHE_METADATA_CLASS ||
        existingMetadataBinding.script_name !== undefined)
    ) {
      throw new Error(`The ${CACHE_METADATA_BINDING} Durable Object binding is incompatible.`);
    }
    code = setTopLevelJsonProperty(code, "durable_objects", {
      ...durableObjects,
      bindings: existingMetadataBinding
        ? existingDurableBindings
        : [
            ...existingDurableBindings,
            { name: CACHE_METADATA_BINDING, class_name: CACHE_METADATA_CLASS },
          ],
    });

    const migrations = config.migrations;
    if (migrations !== undefined && !Array.isArray(migrations)) {
      throw new Error("The existing Wrangler config has an invalid migrations value.");
    }
    const existingMigrations = (migrations ?? []) as unknown[];
    if (existingMigrations.some((migration) => !isUnknownRecord(migration))) {
      throw new Error("The existing Wrangler config has an invalid Durable Object migration.");
    }
    if (existingMigrations.length > 0) {
      throw new Error(
        "Self-contained Workers Response Store cannot be combined with migration-based Durable Objects. Convert the existing Durable Objects to declarative exports or use service-binding mode.",
      );
    }
  }

  return updateWorkerExports ? setTopLevelJsonProperty(code, "exports", workerExports) : code;
}

export function generateResponseStoreWranglerConfig(appWranglerCode: string, root: string): string {
  const appConfig = JSON.parse(stripJsonComments(appWranglerCode)) as Record<string, unknown>;
  const serviceName = readResponseStoreServiceName(root, appConfig);
  const compatibilityDate =
    typeof appConfig.compatibility_date === "string"
      ? appConfig.compatibility_date
      : new Date().toISOString().split("T")[0];
  const compatibilityFlags = ["nodejs_compat"];
  if (compatibilityDate < CTX_EXPORTS_DEFAULT_DATE) {
    compatibilityFlags.push("enable_ctx_exports");
  }
  return `${JSON.stringify(
    {
      $schema: "node_modules/wrangler/config-schema.json",
      name: serviceName,
      main: RESPONSE_STORE_MAIN,
      compatibility_date: compatibilityDate,
      compatibility_flags: compatibilityFlags,
      workers_dev: false,
      preview_urls: false,
      cache: { enabled: true },
      exports: {
        default: { type: "worker", cache: { enabled: false } },
        ResponseStoreBinding: { type: "worker", cache: { enabled: true } },
        [CACHE_METADATA_CLASS]: CACHE_METADATA_EXPORT,
      },
      r2_buckets: [
        {
          binding: CACHE_BODIES_BINDING,
          bucket_name: compactResourceName(serviceName, "-cache-bodies", 63),
        },
      ],
      durable_objects: {
        bindings: [{ name: CACHE_METADATA_BINDING, class_name: CACHE_METADATA_CLASS }],
      },
      ...(typeof appConfig.account_id === "string" ? { account_id: appConfig.account_id } : {}),
    },
    null,
    2,
  )}\n`;
}

export function updateWranglerConfigForCloudflare(
  code: string,
  options: CloudflareInitOptions,
  context: { root?: string } = {},
): string {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(stripJsonComments(code)) as Record<string, unknown>;
  } catch (cause) {
    throw new Error("Could not parse the existing Wrangler JSON/JSONC config.", { cause });
  }
  if (Object.hasOwn(config, "pages_build_output_dir")) {
    throw new Error(
      'The existing Wrangler config uses "pages_build_output_dir", which cannot be combined with the Worker "main" required by vinext. Remove "pages_build_output_dir" and rerun vinext init.',
    );
  }
  let output = code;
  // Without `main` and `assets` the Cloudflare plugin builds the project as
  // assets-only: the build emits no `dist/server/wrangler.json`, and the deploy
  // reports success while every route 404s. Keep these in sync with
  // `generateWranglerConfig`, which writes them on the from-scratch path.
  if (!findTopLevelJsonProperty(output, "main")) {
    const workerEntry = resolveWorkerEntry(context.root ?? process.cwd());
    output = appendTopLevelJsonProperty(output, `  "main": ${JSON.stringify(workerEntry)}`);
  }
  if (!findTopLevelJsonProperty(output, "assets")) {
    output = appendTopLevelJsonProperty(
      output,
      '  "assets": { "directory": "dist/client", "not_found_handling": "none", "binding": "ASSETS" }',
    );
  }
  if (options.cdnCache === "workers-cache") {
    const cacheProperty = findTopLevelJsonProperty(output, "cache");
    if (!cacheProperty) {
      output = appendTopLevelJsonProperty(output, '  "cache": { "enabled": true }');
    } else {
      const cache = JSON.parse(
        stripJsonComments(output.slice(cacheProperty.valueStart, cacheProperty.valueEnd)),
      ) as Record<string, unknown> | null;
      if (!cache || cache.enabled !== true) {
        const updatedCache = JSON.stringify({ ...cache, enabled: true });
        output = `${output.slice(0, cacheProperty.valueStart)}${updatedCache}${output.slice(cacheProperty.valueEnd)}`;
      }
    }
    const versionMetadataProperty = findTopLevelJsonProperty(output, "version_metadata");
    if (!versionMetadataProperty) {
      output = appendTopLevelJsonProperty(
        output,
        `  "version_metadata": { "binding": "${DEFAULT_VERSION_METADATA_BINDING}" }`,
      );
    } else {
      const versionMetadata = JSON.parse(
        stripJsonComments(
          output.slice(versionMetadataProperty.valueStart, versionMetadataProperty.valueEnd),
        ),
      ) as { binding?: unknown } | null;
      if (
        !versionMetadata ||
        typeof versionMetadata.binding !== "string" ||
        versionMetadata.binding.length === 0
      ) {
        output = `${output.slice(0, versionMetadataProperty.valueStart)}{ "binding": "${DEFAULT_VERSION_METADATA_BINDING}" }${output.slice(versionMetadataProperty.valueEnd)}`;
      }
    }
  }
  if (options.imageOptimization === "cloudflare-images") {
    const imagesProperty = findTopLevelJsonProperty(output, "images");
    if (!imagesProperty) {
      output = appendTopLevelJsonProperty(output, '  "images": { "binding": "IMAGES" }');
    } else {
      const images = JSON.parse(
        stripJsonComments(output.slice(imagesProperty.valueStart, imagesProperty.valueEnd)),
      ) as { binding?: unknown } | null;
      if (!images || typeof images.binding !== "string" || images.binding.length === 0) {
        output = `${output.slice(0, imagesProperty.valueStart)}{ "binding": "IMAGES" }${output.slice(imagesProperty.valueEnd)}`;
      }
    }
  }
  if (options.dataCache === "kv") {
    const kvProperty = findTopLevelJsonProperty(output, "kv_namespaces");
    if (!kvProperty) {
      output = appendTopLevelJsonProperty(
        output,
        '  "kv_namespaces": [{ "binding": "VINEXT_KV_CACHE", "id": "<your-kv-namespace-id>" }]',
      );
    } else {
      const rawValue = output.slice(kvProperty.valueStart, kvProperty.valueEnd);
      const namespaces = JSON.parse(stripJsonComments(rawValue)) as Array<{ binding?: string }>;
      if (!namespaces.some((namespace) => namespace.binding === "VINEXT_KV_CACHE")) {
        const closing = kvProperty.valueEnd - 1;
        const content = output.slice(kvProperty.valueStart + 1, closing);
        const separator = content.trim() ? `${/,\s*$/.test(content) ? "" : ","}\n    ` : "";
        output = `${output.slice(0, closing)}${separator}{ "binding": "VINEXT_KV_CACHE", "id": "<your-kv-namespace-id>" }${output.slice(closing)}`;
      }
    }
  }
  if (options.cdnCache === "response-store") {
    output = configureResponseStoreWrangler(
      output,
      config,
      options.responseStoreMode ?? "service-binding",
      context.root ?? process.cwd(),
    );
  }
  return output;
}

export function getWranglerImagesBinding(code: string): string {
  const property = findTopLevelJsonProperty(code, "images");
  if (!property) return "IMAGES";
  const images = JSON.parse(
    stripJsonComments(code.slice(property.valueStart, property.valueEnd)),
  ) as { binding?: unknown } | null;
  return images && typeof images.binding === "string" && images.binding.length > 0
    ? images.binding
    : "IMAGES";
}

export function getWranglerVersionMetadataBinding(code: string): string {
  const property = findTopLevelJsonProperty(code, "version_metadata");
  if (!property) return DEFAULT_VERSION_METADATA_BINDING;
  const versionMetadata = JSON.parse(
    stripJsonComments(code.slice(property.valueStart, property.valueEnd)),
  ) as { binding?: unknown } | null;
  return versionMetadata &&
    typeof versionMetadata.binding === "string" &&
    versionMetadata.binding.length > 0
    ? versionMetadata.binding
    : DEFAULT_VERSION_METADATA_BINDING;
}

function cacheImports(options: CloudflareInitOptions): string[] {
  const imports: string[] = [];
  if (options.dataCache === "kv") {
    imports.push('import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";');
  }
  if (options.cdnCache === "workers-cache") {
    imports.push('import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";');
  }
  if (options.cdnCache === "response-store") {
    imports.push(
      'import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";',
    );
  }
  if (options.imageOptimization === "cloudflare-images") {
    imports.push('import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";');
  }
  return imports;
}

function vinextExpression(
  options: CloudflareInitOptions,
  binding = "vinext",
  imageBinding = "imagesOptimizer",
  imagesBinding = "IMAGES",
  prerender = false,
  versionMetadataBinding = DEFAULT_VERSION_METADATA_BINDING,
  responseStoreBinding = "responseStoreAdapter",
  resolvedCacheEntries?: Array<{ name: "data" | "cdn"; expression: string }>,
): string {
  const responseStore = options.cdnCache === "response-store";
  const cacheEntries =
    resolvedCacheEntries?.map(({ name, expression }) => `${name}: ${expression}`) ?? [];
  if (!resolvedCacheEntries) {
    if (options.dataCache === "kv") {
      cacheEntries.push("data: kvDataAdapter()");
    }
    if (options.cdnCache === "workers-cache") {
      const adapterOptions =
        versionMetadataBinding === DEFAULT_VERSION_METADATA_BINDING
          ? ""
          : `{ versionMetadataBinding: ${JSON.stringify(versionMetadataBinding)} }`;
      cacheEntries.push(`cdn: cdnAdapter(${adapterOptions})`);
    }
  }
  const optionEntries: string[] = [];
  if (responseStore) {
    optionEntries.push(
      `cache: ${responseStoreBinding}(${options.responseStoreMode === "self-contained" ? '{ mode: "self-contained" }' : ""})`,
    );
  } else if (cacheEntries.length > 0) {
    optionEntries.push(`cache: { ${cacheEntries.join(", ")} }`);
  }
  if (options.imageOptimization === "cloudflare-images") {
    const adapterOptions =
      imagesBinding === "IMAGES" ? "" : `{ binding: ${JSON.stringify(imagesBinding)} }`;
    optionEntries.push(`images: { optimizer: ${imageBinding}(${adapterOptions}) }`);
  }
  if (prerender) {
    optionEntries.push(`prerender: { routes: "*" }`);
  }
  return optionEntries.length === 0
    ? `${binding}()`
    : `${binding}({\n  ${optionEntries.join(",\n  ")},\n})`;
}

/** Generate vite.config.ts for App Router */
export function generateAppRouterViteConfig(
  info?: CloudflareProjectInfo,
  options: CloudflareInitOptions = DEFAULT_CLOUDFLARE_INIT_OPTIONS,
  imagesBinding = "IMAGES",
  prerender = false,
  versionMetadataBinding = DEFAULT_VERSION_METADATA_BINDING,
): string {
  const imports: string[] = [
    `import { defineConfig } from "vite";`,
    `import vinext from "vinext";`,
    `import { cloudflare } from "@cloudflare/vite-plugin";`,
    ...cacheImports(options),
  ];

  if (info?.nativeModulesToStub && info.nativeModulesToStub.length > 0) {
    imports.push(`import path from "node:path";`);
  }

  if (info?.hasTailwindV4) {
    imports.push(`import tailwindcss from "@tailwindcss/vite";`);
  }

  const plugins: string[] = [];

  if (info?.hasMDX) {
    plugins.push(`    // vinext auto-injects @mdx-js/rollup with plugins from next.config`);
  }

  if (info?.hasTailwindV4) {
    plugins.push(`    tailwindcss(),`);
  }
  plugins.push(
    `    ${vinextExpression(
      options,
      "vinext",
      "imagesOptimizer",
      imagesBinding,
      prerender,
      versionMetadataBinding,
    ).replace(/\n/g, "\n    ")},`,
  );

  plugins.push(`    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),`);

  // Build resolve.alias for native module stubs (tsconfig paths are handled
  // by the vinext plugin's native Vite support).
  let resolveBlock = "";
  const aliases: string[] = [];

  if (info?.nativeModulesToStub && info.nativeModulesToStub.length > 0) {
    for (const mod of info.nativeModulesToStub) {
      aliases.push(`      "${mod}": path.resolve(__dirname, "empty-stub.js"),`);
    }
  }

  if (aliases.length > 0) {
    resolveBlock = `\n  resolve: {\n    alias: {\n${aliases.join("\n")}\n    },\n  },`;
  }

  return `${imports.join("\n")}

export default defineConfig({
  plugins: [
${plugins.join("\n")}
  ],${resolveBlock}
});
`;
}

/** Generate vite.config.ts for Pages Router */
export function generatePagesRouterViteConfig(
  info?: CloudflareProjectInfo,
  options: CloudflareInitOptions = DEFAULT_CLOUDFLARE_INIT_OPTIONS,
  imagesBinding = "IMAGES",
  prerender = false,
  versionMetadataBinding = DEFAULT_VERSION_METADATA_BINDING,
): string {
  const imports: string[] = [
    `import { defineConfig } from "vite";`,
    `import vinext from "vinext";`,
    `import { cloudflare } from "@cloudflare/vite-plugin";`,
    ...cacheImports(options),
  ];

  if (info?.nativeModulesToStub && info.nativeModulesToStub.length > 0) {
    imports.push(`import path from "node:path";`);
  }

  if (info?.hasTailwindV4) {
    imports.push(`import tailwindcss from "@tailwindcss/vite";`);
  }

  // Build resolve.alias for native module stubs (tsconfig paths are handled
  // by the vinext plugin's native Vite support).
  let resolveBlock = "";
  const aliases: string[] = [];

  if (info?.nativeModulesToStub && info.nativeModulesToStub.length > 0) {
    for (const mod of info.nativeModulesToStub) {
      aliases.push(`      "${mod}": path.resolve(__dirname, "empty-stub.js"),`);
    }
  }

  if (aliases.length > 0) {
    resolveBlock = `\n  resolve: {\n    alias: {\n${aliases.join("\n")}\n    },\n  },`;
  }

  return `${imports.join("\n")}

export default defineConfig({
  plugins: [
${info?.hasTailwindV4 ? "    tailwindcss(),\n" : ""}    ${vinextExpression(
    options,
    "vinext",
    "imagesOptimizer",
    imagesBinding,
    prerender,
    versionMetadataBinding,
  ).replace(/\n/g, "\n    ")},
    cloudflare(),
  ],${resolveBlock}
});
`;
}

type AstNode = ESTree.Node & { start: number; end: number };
type AstObject = ESTree.ObjectExpression & AstNode;
type AstProperty = Extract<AstObject["properties"][number], { type: "Property" }>;

function parseViteConfig(filePath: string, code: string): ESTree.Program {
  let parseSync: typeof import("vite").parseSync;
  try {
    ({ parseSync } = require("vite") as typeof import("vite"));
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;
    if (maybeNodeError.code === "MODULE_NOT_FOUND" && maybeNodeError.message.includes("vite")) {
      throw new Error(
        `Could not update ${path.basename(filePath)} because the "vite" package is not available to parse the existing config. Install dependencies first, or remove the existing Vite config and rerun vinext init.`,
      );
    }
    throw error;
  }
  const extension = path.extname(filePath).slice(1);
  const lang = extension === "ts" || extension === "mts" || extension === "cts" ? "ts" : "js";
  const parsed = parseSync(path.basename(filePath), code, {
    astType: "ts",
    lang,
    sourceType: "module",
  });
  const error = parsed.errors.find((diagnostic) => diagnostic.severity === "Error");
  if (error) throw new Error(`Could not parse ${path.basename(filePath)}: ${error.message}`);
  return parsed.program;
}

function propertyName(property: AstProperty): string | undefined {
  if (property.computed) return undefined;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal" && typeof property.key.value === "string") {
    return property.key.value;
  }
  return undefined;
}

function findProperty(object: AstObject, name: string): AstProperty | undefined {
  return object.properties.find(
    (property): property is AstProperty =>
      property.type === "Property" && propertyName(property) === name,
  );
}

function findPluginsProperty(config: AstObject): AstProperty | undefined {
  let plugins: AstProperty | undefined;
  let pluginsIndex = -1;
  let lastUnknownIndex = -1;
  for (const [index, property] of config.properties.entries()) {
    if (property.type === "SpreadElement") {
      lastUnknownIndex = index;
      continue;
    }
    const name =
      propertyName(property) ??
      (property.computed && property.key.type === "Literal" ? property.key.value : undefined);
    if (name === "plugins") {
      plugins = property;
      pluginsIndex = index;
    } else if (property.computed && name === undefined) {
      lastUnknownIndex = index;
    }
  }
  if (lastUnknownIndex > pluginsIndex) {
    throw new Error(
      "The Vite config's plugins option cannot be updated because a later spread or computed property may override it.",
    );
  }
  return plugins;
}

function unwrapObject(expression: ESTree.Node): AstObject | undefined {
  const unwrapped = unwrapExpression(expression);
  return unwrapped?.type === "ObjectExpression" ? (unwrapped as AstObject) : undefined;
}

function isViteNamespaceBinding(program: ESTree.Program, name: string): boolean {
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration" && statement.source.value === "vite") {
      if (
        statement.specifiers.some(
          (specifier) =>
            specifier.type === "ImportNamespaceSpecifier" && specifier.local.name === name,
        )
      ) {
        return true;
      }
      continue;
    }
    const variableDeclaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (variableDeclaration?.type !== "VariableDeclaration" || variableDeclaration.kind !== "const")
      continue;
    for (const declaration of variableDeclaration.declarations) {
      const initializer = unwrapExpression(declaration.init);
      if (
        declaration.id.type === "Identifier" &&
        declaration.id.name === name &&
        initializer?.type === "CallExpression" &&
        initializer.callee.type === "Identifier" &&
        initializer.callee.name === "require" &&
        initializer.arguments[0]?.type === "Literal" &&
        initializer.arguments[0].value === "vite"
      ) {
        return true;
      }
    }
  }
  return false;
}

function isViteDefineConfigBinding(program: ESTree.Program, name: string): boolean {
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration" && statement.source.value === "vite") {
      if (
        statement.specifiers.some(
          (specifier) =>
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "defineConfig" &&
            specifier.local.name === name,
        )
      ) {
        return true;
      }
      continue;
    }
    const variableDeclaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (variableDeclaration?.type !== "VariableDeclaration" || variableDeclaration.kind !== "const")
      continue;
    for (const declaration of variableDeclaration.declarations) {
      const initializer = unwrapExpression(declaration.init);
      if (
        declaration.id.type !== "ObjectPattern" ||
        initializer?.type !== "CallExpression" ||
        initializer.callee.type !== "Identifier" ||
        initializer.callee.name !== "require" ||
        initializer.arguments[0]?.type !== "Literal" ||
        initializer.arguments[0].value !== "vite"
      ) {
        continue;
      }
      if (
        declaration.id.properties.some(
          (property) =>
            property.type === "Property" &&
            property.key.type === "Identifier" &&
            property.key.name === "defineConfig" &&
            property.value.type === "Identifier" &&
            property.value.name === name,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function isViteDefineConfigCall(program: ESTree.Program, call: ESTree.CallExpression): boolean {
  const callee = unwrapExpression(call.callee) ?? call.callee;
  if (callee.type === "Identifier") return isViteDefineConfigBinding(program, callee.name);
  if (callee.type !== "MemberExpression") return false;
  const property = unwrapExpression(callee.property) ?? callee.property;
  const propertyIsDefineConfig = callee.computed
    ? property.type === "Literal" && property.value === "defineConfig"
    : property.type === "Identifier" && property.name === "defineConfig";
  const object = unwrapExpression(callee.object) ?? callee.object;
  return (
    propertyIsDefineConfig &&
    object.type === "Identifier" &&
    isViteNamespaceBinding(program, object.name)
  );
}

function findSingleDirectReturn(body: ESTree.BlockStatement): ESTree.ReturnStatement | undefined {
  const directReturns = body.body.filter(
    (statement): statement is ESTree.ReturnStatement => statement.type === "ReturnStatement",
  );
  const reachableReturns: ESTree.ReturnStatement[] = [];
  const collectReturns = (node: ESTree.Node): void => {
    if (node.type === "ReturnStatement") {
      reachableReturns.push(node);
      return;
    }
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      return;
    }
    forEachAstChild(node, collectReturns);
  };
  for (const statement of body.body) collectReturns(statement);
  return directReturns.length === 1 &&
    reachableReturns.length === 1 &&
    reachableReturns[0] === directReturns[0]
    ? directReturns[0]
    : undefined;
}

function findConfigObjectInCall(
  program: ESTree.Program,
  call: ESTree.CallExpression,
): AstObject | undefined {
  if (!isViteDefineConfigCall(program, call) || call.arguments.length === 0) return undefined;
  const firstArgument = call.arguments[0];
  if (firstArgument.type === "SpreadElement") return undefined;
  const argumentObject = unwrapObject(firstArgument);
  if (argumentObject) return argumentObject;
  const callback = unwrapExpression(firstArgument) ?? firstArgument;
  if (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") {
    return undefined;
  }
  if (!callback.body) return undefined;
  if (callback.body.type !== "BlockStatement") return unwrapObject(callback.body);
  const returnStatement = findSingleDirectReturn(callback.body);
  if (!returnStatement?.argument) return undefined;
  const returned = unwrapExpression(returnStatement.argument) ?? returnStatement.argument;
  const direct = unwrapObject(returned);
  if (direct) return direct;
  return returned.type === "Identifier"
    ? findVariableObjectInStatements(program, callback.body.body, returned.name)
    : undefined;
}

function findVariableObjectInStatements(
  program: ESTree.Program,
  statements: ESTree.Statement[],
  name: string,
): AstObject | undefined {
  for (const statement of statements) {
    const variableDeclaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (variableDeclaration?.type !== "VariableDeclaration" || variableDeclaration.kind !== "const")
      continue;
    for (const declaration of variableDeclaration.declarations) {
      if (
        declaration.id.type !== "Identifier" ||
        declaration.id.name !== name ||
        !declaration.init
      ) {
        continue;
      }
      const initializer = unwrapExpression(declaration.init) ?? declaration.init;
      const direct = unwrapObject(initializer);
      if (direct) return direct;
      if (initializer.type === "CallExpression")
        return findConfigObjectInCall(program, initializer);
      return undefined;
    }
  }
  return undefined;
}

function findVariableObject(program: ESTree.Program, name: string): AstObject | undefined {
  return findVariableObjectInStatements(program, program.body, name);
}

function findConfigObject(program: ESTree.Program): AstObject | undefined {
  const defaultExport = program.body.find(
    (statement): statement is ESTree.ExportDefaultDeclaration =>
      statement.type === "ExportDefaultDeclaration",
  );
  if (!defaultExport) {
    for (const statement of program.body) {
      if (
        statement.type !== "ExportNamedDeclaration" ||
        statement.source ||
        statement.exportKind === "type"
      ) {
        continue;
      }
      const defaultSpecifier = statement.specifiers.find(
        (specifier) =>
          specifier.type === "ExportSpecifier" &&
          specifier.exportKind !== "type" &&
          ((specifier.exported.type === "Identifier" && specifier.exported.name === "default") ||
            (specifier.exported.type === "Literal" && specifier.exported.value === "default")),
      );
      if (defaultSpecifier?.local.type === "Identifier") {
        const config = findVariableObject(program, defaultSpecifier.local.name);
        if (config) return config;
      }
    }
    const commonJsExports = program.body.flatMap((statement) => {
      if (statement.type !== "ExpressionStatement") return [];
      const expression = statement.expression;
      return expression.type === "AssignmentExpression" &&
        expression.operator === "=" &&
        expression.left.type === "MemberExpression" &&
        !expression.left.computed &&
        expression.left.object.type === "Identifier" &&
        expression.left.object.name === "module" &&
        expression.left.property.type === "Identifier" &&
        expression.left.property.name === "exports"
        ? [expression.right]
        : [];
    });
    if (commonJsExports.length !== 1) return undefined;
    const right = unwrapExpression(commonJsExports[0]) ?? commonJsExports[0];
    const direct = unwrapObject(right);
    if (direct) return direct;
    if (right.type === "Identifier") return findVariableObject(program, right.name);
    if (right.type === "CallExpression") return findConfigObjectInCall(program, right);
    return undefined;
  }
  if (defaultExport.declaration.type === "FunctionDeclaration") return undefined;

  const exported = defaultExport.declaration;
  if (exported.type === "ClassDeclaration" || exported.type === "TSInterfaceDeclaration") {
    return undefined;
  }
  const declaration = unwrapExpression(exported) ?? exported;
  const direct = unwrapObject(declaration);
  if (direct) return direct;
  if (declaration.type === "Identifier") return findVariableObject(program, declaration.name);
  return declaration.type === "CallExpression"
    ? findConfigObjectInCall(program, declaration)
    : undefined;
}

function findOwningConstInitializer(
  program: ESTree.Program,
  target: ESTree.Node,
): ESTree.Node | undefined {
  const path = findAstPath(program, target);
  if (!path) return undefined;
  for (let index = path.length - 1; index > 0; index--) {
    const node = path[index];
    const parent = path[index - 1];
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init &&
      parent.type === "VariableDeclaration" &&
      parent.kind === "const"
    ) {
      return unwrapExpression(node.init) ?? node.init;
    }
  }
  return undefined;
}

function expressionResolvesToInitializer(
  program: ESTree.Program,
  target: ESTree.Node,
  expression: ESTree.Node,
  expected: ESTree.Node,
  seen = new Set<string>(),
): boolean {
  const reference = unwrapExpression(expression);
  if (reference?.type === "MemberExpression") {
    return expressionResolvesToInitializer(
      program,
      target,
      rootReference(reference),
      expected,
      seen,
    );
  }
  if (reference?.type !== "Identifier" || seen.has(reference.name)) return false;
  const initializer =
    findVisibleConstInitializer(program, target, reference.name) ??
    findVisibleDestructuredSource(program, target, reference.name);
  return (
    initializer === expected ||
    Boolean(
      initializer &&
      expressionResolvesToInitializer(
        program,
        target,
        initializer,
        expected,
        new Set(seen).add(reference.name),
      ),
    )
  );
}

function rootReference(node: ESTree.Node): ESTree.Node {
  let root = unwrapExpression(node) ?? node;
  while (root.type === "MemberExpression") {
    root = unwrapExpression(root.object) ?? root.object;
  }
  return root;
}

function memberName(member: ESTree.MemberExpression): string | undefined {
  if (member.computed) {
    return member.property.type === "Literal" && typeof member.property.value === "string"
      ? member.property.value
      : undefined;
  }
  return member.property.type === "Identifier" ? member.property.name : undefined;
}

const MUTATING_METHODS = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);
const OBJECT_MUTATORS = new Set(["assign", "defineProperties", "defineProperty", "setPrototypeOf"]);
const REFLECT_MUTATORS = new Set(["defineProperty", "deleteProperty", "set", "setPrototypeOf"]);

function isUnshadowedGlobal(
  program: ESTree.Program,
  target: ESTree.Node,
  binding: string,
): boolean {
  return (
    !collectTopLevelBindings(program).has(binding) &&
    !collectShadowedBindings(program, target).has(binding)
  );
}

function hasLaterInitializerMutation(program: ESTree.Program, initializer: ESTree.Node): boolean {
  let mutated = false;
  const visit = (node: ESTree.Node): void => {
    if (mutated) return;
    const afterInitializer =
      (node as Partial<AstNode>).start !== undefined &&
      (initializer as Partial<AstNode>).end !== undefined &&
      (node as AstNode).start > (initializer as AstNode).end;
    let member: ESTree.MemberExpression | undefined;
    if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression") {
      member = node.left;
    } else if (node.type === "UpdateExpression" && node.argument.type === "MemberExpression") {
      member = node.argument;
    } else if (
      node.type === "UnaryExpression" &&
      node.operator === "delete" &&
      node.argument.type === "MemberExpression"
    ) {
      member = node.argument;
    }
    if (
      member &&
      afterInitializer &&
      expressionResolvesToInitializer(program, node, rootReference(member), initializer)
    ) {
      mutated = true;
      return;
    }
    const callee = node.type === "CallExpression" ? unwrapExpression(node.callee) : undefined;
    if (afterInitializer && callee?.type === "MemberExpression") {
      const method = memberName(callee);
      const object = unwrapExpression(callee.object) ?? callee.object;
      const firstArgument = node.type === "CallExpression" ? node.arguments[0] : undefined;
      const staticMutatorTarget =
        object.type === "Identifier" &&
        isUnshadowedGlobal(program, node, object.name) &&
        ((object.name === "Object" && method && OBJECT_MUTATORS.has(method)) ||
          (object.name === "Reflect" && method && REFLECT_MUTATORS.has(method))) &&
        firstArgument &&
        firstArgument.type !== "SpreadElement"
          ? firstArgument
          : undefined;
      const methodTarget = method && MUTATING_METHODS.has(method) ? callee.object : undefined;
      const target = staticMutatorTarget ?? methodTarget;
      if (
        target &&
        expressionResolvesToInitializer(program, node, rootReference(target), initializer)
      ) {
        mutated = true;
        return;
      }
    }
    forEachAstChild(node, visit);
  };
  visit(program);
  return mutated;
}

function assertConfigPropertiesAreStatic(program: ESTree.Program, config: AstObject): void {
  const initializer = findOwningConstInitializer(program, config);
  if (initializer && hasLaterInitializerMutation(program, initializer)) {
    throw new Error(
      "The Vite config cannot be updated because properties are mutated after its static initializer.",
    );
  }
}

function assertPluginArrayIsStatic(
  program: ESTree.Program,
  array: (ESTree.ArrayExpression & AstNode) | undefined,
): void {
  if (!array) return;
  const initializer = findOwningConstInitializer(program, array);
  if (initializer === array && hasLaterInitializerMutation(program, initializer)) {
    throw new Error(
      "The Vite config's plugins option cannot be updated because its array is mutated after initialization.",
    );
  }
}

function importInsertionOffset(program: ESTree.Program): number {
  let offset = program.hashbang?.end ?? 0;
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") break;
    offset = (statement as AstNode).end;
  }
  return offset;
}

function collectPatternBindings(pattern: ESTree.Node, bindings: Set<string>): void {
  if (pattern.type === "Identifier") {
    bindings.add(pattern.name);
    return;
  }
  if (pattern.type === "RestElement") {
    collectPatternBindings(pattern.argument, bindings);
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    collectPatternBindings(pattern.left, bindings);
    return;
  }
  if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements) {
      if (element) collectPatternBindings(element, bindings);
    }
    return;
  }
  if (pattern.type !== "ObjectPattern") return;
  for (const property of pattern.properties) {
    if (property.type === "RestElement") collectPatternBindings(property.argument, bindings);
    else collectPatternBindings(property.value, bindings);
  }
}

function collectTopLevelBindings(program: ESTree.Program): Set<string> {
  const bindings = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) bindings.add(specifier.local.name);
      continue;
    }
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (!declaration) continue;
    if (declaration.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        collectPatternBindings(declarator.id, bindings);
      }
    } else if (
      (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") &&
      declaration.id
    ) {
      bindings.add(declaration.id.name);
    } else if (declaration.type === "TSEnumDeclaration") {
      bindings.add(declaration.id.name);
    } else if (declaration.type === "TSModuleDeclaration" && declaration.id.type === "Identifier") {
      bindings.add(declaration.id.name);
    }
  }
  for (const statement of program.body) collectNestedFunctionVarBindings(statement, bindings);
  return bindings;
}

function allocateBinding(bindings: Set<string>, preferred: string): string {
  if (!bindings.has(preferred)) {
    bindings.add(preferred);
    return preferred;
  }
  let suffix = 2;
  while (bindings.has(`${preferred}${suffix}`)) suffix++;
  const binding = `${preferred}${suffix}`;
  bindings.add(binding);
  return binding;
}

function findImportedBinding(
  program: ESTree.Program,
  source: string,
  imported: string,
  excludedBindings?: Set<string>,
): string | undefined {
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== source) continue;
    for (const specifier of statement.specifiers) {
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.imported.type === "Identifier" &&
        specifier.imported.name === imported &&
        !excludedBindings?.has(specifier.local.name)
      ) {
        return specifier.local.name;
      }
    }
  }
  return undefined;
}

function ensureNamedImport(
  program: ESTree.Program,
  output: MagicString,
  source: string,
  imported: string,
  binding: string,
  reuseExisting = true,
): string {
  const existing = findImportedBinding(program, source, imported);
  if (existing && reuseExisting) return existing;

  const declaration = program.body.find(
    (statement): statement is ESTree.ImportDeclaration =>
      statement.type === "ImportDeclaration" && statement.source.value === source,
  );
  if (declaration) {
    const named = declaration.specifiers.filter(
      (specifier): specifier is ESTree.ImportSpecifier => specifier.type === "ImportSpecifier",
    );
    if (named.length > 0) {
      const specifier = binding === imported ? imported : `${imported} as ${binding}`;
      output.appendLeft((named[named.length - 1] as AstNode).end, `, ${specifier}`);
      return binding;
    }
  }

  const offset = importInsertionOffset(program);
  const specifier = binding === imported ? imported : `${imported} as ${binding}`;
  const sourceText = `import { ${specifier} } from ${JSON.stringify(source)};`;
  output.appendLeft(offset, offset === 0 ? `${sourceText}\n` : `\n${sourceText}`);
  return binding;
}

function ensureDefaultImport(
  program: ESTree.Program,
  output: MagicString,
  source: string,
  binding: string,
  reuseExisting = true,
): string {
  const declaration = program.body.find(
    (statement): statement is ESTree.ImportDeclaration =>
      statement.type === "ImportDeclaration" && statement.source.value === source,
  );
  const existing = declaration?.specifiers.find(
    (specifier): specifier is ESTree.ImportDefaultSpecifier =>
      specifier.type === "ImportDefaultSpecifier",
  );
  if (existing && reuseExisting) return existing.local.name;

  const offset = importInsertionOffset(program);
  const sourceText = `import ${binding} from ${JSON.stringify(source)};`;
  output.appendLeft(offset, offset === 0 ? `${sourceText}\n` : `\n${sourceText}`);
  return binding;
}

function findDefaultImportedBinding(
  program: ESTree.Program,
  source: string,
  excludedBindings?: Set<string>,
): { binding: string; namespace: boolean } | undefined {
  for (const statement of program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.source.value !== source ||
      statement.importKind === "type"
    ) {
      continue;
    }
    const specifier = statement.specifiers.find(
      (candidate) =>
        (candidate.type === "ImportDefaultSpecifier" ||
          candidate.type === "ImportNamespaceSpecifier" ||
          (candidate.type === "ImportSpecifier" &&
            candidate.importKind !== "type" &&
            candidate.imported.type === "Identifier" &&
            candidate.imported.name === "default")) &&
        !excludedBindings?.has(candidate.local.name),
    );
    if (specifier) {
      return {
        binding: specifier.local.name,
        namespace: specifier.type === "ImportNamespaceSpecifier",
      };
    }
  }
  return undefined;
}

function findDefaultRequiredBinding(
  program: ESTree.Program,
  source: string,
  excludedBindings?: Set<string>,
): { binding: string; namespace: boolean } | undefined {
  for (const statement of program.body) {
    if (statement.type !== "VariableDeclaration" || statement.kind !== "const") continue;
    for (const declaration of statement.declarations) {
      const initializer = unwrapExpression(declaration.init);
      let requireCall: ESTree.CallExpression | undefined;
      let namespace = false;
      if (initializer?.type === "CallExpression") {
        requireCall = initializer;
        namespace = true;
      } else if (
        initializer?.type === "MemberExpression" &&
        ((!initializer.computed &&
          initializer.property.type === "Identifier" &&
          initializer.property.name === "default") ||
          (initializer.computed &&
            initializer.property.type === "Literal" &&
            initializer.property.value === "default"))
      ) {
        const object = unwrapExpression(initializer.object);
        if (object?.type === "CallExpression") requireCall = object;
      }
      if (
        !requireCall ||
        requireCall.callee.type !== "Identifier" ||
        requireCall.callee.name !== "require" ||
        requireCall.arguments[0]?.type !== "Literal" ||
        requireCall.arguments[0].value !== source
      ) {
        continue;
      }
      if (declaration.id.type === "Identifier") {
        if (excludedBindings?.has(declaration.id.name)) continue;
        return { binding: declaration.id.name, namespace };
      }
      if (declaration.id.type !== "ObjectPattern") continue;
      for (const property of declaration.id.properties) {
        if (
          property.type === "Property" &&
          property.key.type === "Identifier" &&
          property.key.name === "default" &&
          property.value.type === "Identifier" &&
          !excludedBindings?.has(property.value.name)
        ) {
          return { binding: property.value.name, namespace: false };
        }
      }
    }
  }
  return undefined;
}

function findDynamicImportPluginBinding(
  program: ESTree.Program,
  source: string,
  excludedBindings?: Set<string>,
): string | undefined {
  for (const statement of program.body) {
    if (statement.type !== "VariableDeclaration" || statement.kind !== "const") continue;
    for (const declaration of statement.declarations) {
      const initializer = unwrapExpression(declaration.init);
      if (
        declaration.id.type !== "Identifier" ||
        excludedBindings?.has(declaration.id.name) ||
        initializer?.type !== "ArrowFunctionExpression" ||
        initializer.params.length !== 0
      ) {
        continue;
      }
      const body = unwrapExpression(initializer.body);
      if (body?.type !== "CallExpression") continue;
      const callee = unwrapExpression(body.callee);
      if (
        callee?.type === "MemberExpression" &&
        !callee.computed &&
        callee.property.type === "Identifier" &&
        callee.property.name === "then"
      ) {
        const imported = unwrapExpression(callee.object);
        if (
          imported?.type === "ImportExpression" &&
          imported.source.type === "Literal" &&
          imported.source.value === source &&
          dynamicImportCallbackCallsDefault(body.arguments[0])
        ) {
          return declaration.id.name;
        }
      }
    }
  }
  return undefined;
}

function dynamicImportCallbackCallsDefault(
  argument: ESTree.CallExpression["arguments"][number] | undefined,
): boolean {
  if (
    !argument ||
    argument.type === "SpreadElement" ||
    (argument.type !== "ArrowFunctionExpression" && argument.type !== "FunctionExpression") ||
    argument.params.length !== 1
  ) {
    return false;
  }
  if (!argument.body) return false;
  const returned =
    argument.body.type === "BlockStatement"
      ? findSingleDirectReturn(argument.body)?.argument
      : argument.body;
  const call = unwrapExpression(returned);
  if (call?.type !== "CallExpression") return false;
  const parameter = argument.params[0];
  if (parameter.type === "Identifier") {
    const callbackCallee = unwrapExpression(call.callee);
    return Boolean(
      callbackCallee?.type === "MemberExpression" &&
      callbackCallee.object.type === "Identifier" &&
      callbackCallee.object.name === parameter.name &&
      ((!callbackCallee.computed &&
        callbackCallee.property.type === "Identifier" &&
        callbackCallee.property.name === "default") ||
        (callbackCallee.computed &&
          callbackCallee.property.type === "Literal" &&
          callbackCallee.property.value === "default")),
    );
  }
  if (parameter.type !== "ObjectPattern" || call.callee.type !== "Identifier") return false;
  const calleeName = call.callee.name;
  return parameter.properties.some(
    (property) =>
      property.type === "Property" &&
      ((property.key.type === "Identifier" && property.key.name === "default") ||
        (property.key.type === "Literal" && property.key.value === "default")) &&
      property.value.type === "Identifier" &&
      property.value.name === calleeName,
  );
}

function findRequiredBinding(
  program: ESTree.Program,
  source: string,
  imported: string,
  excludedBindings?: Set<string>,
): string | undefined {
  if (imported === "default") {
    return findDefaultRequiredBinding(program, source, excludedBindings)?.binding;
  }
  for (const statement of program.body) {
    if (statement.type !== "VariableDeclaration" || statement.kind !== "const") continue;
    for (const declaration of statement.declarations) {
      const initializer = unwrapExpression(declaration.init);
      if (
        initializer?.type !== "CallExpression" ||
        initializer.callee.type !== "Identifier" ||
        initializer.callee.name !== "require" ||
        initializer.arguments[0]?.type !== "Literal" ||
        initializer.arguments[0].value !== source
      ) {
        continue;
      }
      if (declaration.id.type !== "ObjectPattern") continue;
      for (const property of declaration.id.properties) {
        if (
          property.type === "Property" &&
          property.key.type === "Identifier" &&
          property.key.name === imported &&
          property.value.type === "Identifier" &&
          !excludedBindings?.has(property.value.name)
        ) {
          return property.value.name;
        }
      }
    }
  }
  return undefined;
}

function requireInsertionOffset(program: ESTree.Program): number {
  let offset = program.hashbang?.end ?? 0;
  for (const statement of program.body) {
    if (
      statement.type === "ExpressionStatement" &&
      statement.expression.type === "Literal" &&
      typeof statement.expression.value === "string"
    ) {
      offset = (statement as AstNode).end;
      continue;
    }
    break;
  }
  return offset;
}

function ensureNamedRequire(
  program: ESTree.Program,
  output: MagicString,
  source: string,
  imported: string,
  binding: string,
  reuseExisting = true,
): string {
  const existing = findRequiredBinding(program, source, imported);
  if (existing && reuseExisting) return existing;
  const offset = requireInsertionOffset(program);
  const property = binding === imported ? imported : `${imported}: ${binding}`;
  const sourceText = `const { ${property} } = require(${JSON.stringify(source)});`;
  output.appendLeft(offset, offset === 0 ? `${sourceText}\n` : `\n${sourceText}`);
  return binding;
}

function ensureDefaultRequire(
  program: ESTree.Program,
  output: MagicString,
  source: string,
  binding: string,
  reuseExisting = true,
): string {
  const existing = findRequiredBinding(program, source, "default");
  if (existing && reuseExisting) return existing;
  const offset = requireInsertionOffset(program);
  const sourceText = `const ${binding} = require(${JSON.stringify(source)});`;
  output.appendLeft(offset, offset === 0 ? `${sourceText}\n` : `\n${sourceText}`);
  return binding;
}

function insertObjectProperty(
  output: MagicString,
  object: AstObject,
  source: string,
  code: string,
): void {
  const offset = object.end - 1;
  const hasProperties = object.properties.length > 0;
  const finalProperty = object.properties.at(-1);
  const hasTrailingComma = finalProperty
    ? endsWithCommaIgnoringWhitespaceAndComments(code.slice(finalProperty.end, offset))
    : false;
  output.appendLeft(offset, `${hasProperties && !hasTrailingComma ? "," : ""}\n${source}\n`);
}

function endsWithCommaIgnoringWhitespaceAndComments(code: string): boolean {
  let index = 0;
  let lastToken = "";
  while (index < code.length) {
    const char = code[index];
    const next = code[index + 1];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < code.length && code[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < code.length && !(code[index] === "*" && code[index + 1] === "/")) {
        index++;
      }
      index += 2;
      continue;
    }
    lastToken = char;
    index++;
  }
  return lastToken === ",";
}

function findCommaIgnoringComments(code: string): number {
  for (let index = 0; index < code.length; index++) {
    if (code[index] === "/" && code[index + 1] === "/") {
      index = code.indexOf("\n", index + 2);
      if (index === -1) return -1;
    } else if (code[index] === "/" && code[index + 1] === "*") {
      index = code.indexOf("*/", index + 2);
      if (index === -1) return -1;
      index++;
    } else if (code[index] === ",") {
      return index;
    }
  }
  return -1;
}

function cloudflarePluginExpression(isAppRouter: boolean, binding: string): string {
  return isAppRouter
    ? `${binding}({\n  viteEnvironment: {\n    name: "rsc",\n    childEnvironments: ["ssr"],\n  },\n})`
    : `${binding}()`;
}

/**
 * An existing bare `cloudflare()` call is left as-is by `ensurePlugins`, which
 * only adds plugins that are absent. For the App Router that silently drops
 * `viteEnvironment`, so the RSC environment never runs in workerd.
 */
function ensureCloudflareViteEnvironment(
  output: MagicString,
  config: AstObject,
  binding: string,
  isAppRouter: boolean,
  code: string,
  program: ESTree.Program,
): void {
  if (!isAppRouter) return;
  const call = findPluginCall(config, binding, program);
  if (!call) return;
  const viteEnvironment = `viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] }`;
  const firstArgument = call.arguments[0];
  if (!firstArgument) {
    output.appendLeft(call.end - 1, `{ ${viteEnvironment} }`);
    return;
  }
  if (firstArgument.type === "SpreadElement" || firstArgument.type !== "ObjectExpression") {
    throw new Error(
      "The cloudflare() plugin options must be a static object for vinext init to configure the App Router Vite environment.",
    );
  }
  const argumentObject = firstArgument as AstObject;
  const viteEnvironmentProperties = argumentObject.properties.filter(
    (property): property is AstProperty =>
      property.type === "Property" && propertyName(property) === "viteEnvironment",
  );
  const existingViteEnvironment = viteEnvironmentProperties.at(-1);
  if (existingViteEnvironment) {
    const propertyIndex = argumentObject.properties.lastIndexOf(existingViteEnvironment);
    if (
      argumentObject.properties
        .slice(propertyIndex + 1)
        .some((property) => property.type === "SpreadElement")
    ) {
      throw new Error(
        "The cloudflare() viteEnvironment option must appear after any spread properties so vinext init can verify it.",
      );
    }
    if (existingViteEnvironment.value.type !== "ObjectExpression") {
      throw new Error(
        'The cloudflare() viteEnvironment option must be a static object with name: "rsc" and childEnvironments containing "ssr".',
      );
    }
    const environmentObject = existingViteEnvironment.value as AstObject;
    const nameProperties = environmentObject.properties.filter(
      (property): property is AstProperty =>
        property.type === "Property" && propertyName(property) === "name",
    );
    const childEnvironmentProperties = environmentObject.properties.filter(
      (property): property is AstProperty =>
        property.type === "Property" && propertyName(property) === "childEnvironments",
    );
    const name = nameProperties[0];
    const childEnvironments = childEnvironmentProperties[0];
    const hasAmbiguousProperties =
      environmentObject.properties.some((property) => property.type === "SpreadElement") ||
      nameProperties.length !== 1 ||
      childEnvironmentProperties.length !== 1;
    const hasRequiredName = name?.value.type === "Literal" && name.value.value === "rsc";
    const hasRequiredChild =
      childEnvironments?.value.type === "ArrayExpression" &&
      childEnvironments.value.elements.some(
        (element) => element?.type === "Literal" && element.value === "ssr",
      );
    if (hasAmbiguousProperties || !hasRequiredName || !hasRequiredChild) {
      throw new Error(
        'The cloudflare() viteEnvironment option must statically set name: "rsc" and include "ssr" in childEnvironments.',
      );
    }
    return;
  }
  const callIndent =
    code
      .slice(0, (call as AstNode).start)
      .split("\n")
      .at(-1)
      ?.match(/^\s*/)?.[0] ?? "";
  insertObjectProperty(output, argumentObject, `${callIndent}  ${viteEnvironment},`, code);
}

function findPluginCall(
  config: AstObject,
  binding: string,
  program: ESTree.Program,
  member?: string,
): (ESTree.CallExpression & AstNode) | undefined {
  const array = findPluginArray(config, program);
  return array
    ? findCallInPluginArray(
        array,
        (call) => calleeMatchesPluginAddition(call.callee, { binding, member }, program, array),
        program,
      )
    : undefined;
}

function findAstPath(root: ESTree.Node, target: ESTree.Node): ESTree.Node[] | undefined {
  if (root === target) return [root];
  let path: ESTree.Node[] | undefined;
  forEachAstChild(root, (child) => {
    if (path) return;
    const childPath = findAstPath(child, target);
    if (childPath) path = [root, ...childPath];
  });
  return path;
}

function collectNestedFunctionVarBindings(node: ESTree.Node, bindings: Set<string>): void {
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "ClassDeclaration" ||
    node.type === "ClassExpression"
  ) {
    return;
  }
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const declarator of node.declarations) collectPatternBindings(declarator.id, bindings);
  }
  forEachAstChild(node, (child) => collectNestedFunctionVarBindings(child, bindings));
}

function collectShadowedBindings(program: ESTree.Program, target: ESTree.Node): Set<string> {
  const bindings = new Set<string>();
  const path = findAstPath(program, target);
  if (!path) return bindings;
  for (const node of path.slice(1)) {
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      for (const parameter of node.params) collectPatternBindings(parameter, bindings);
      if (node.type === "FunctionExpression" && node.id) bindings.add(node.id.name);
      if (node.body?.type === "BlockStatement") {
        for (const statement of node.body.body) {
          collectNestedFunctionVarBindings(statement, bindings);
        }
      }
    }
    if (node.type !== "BlockStatement") continue;
    for (const declaration of node.body) {
      if (declaration?.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          collectPatternBindings(declarator.id, bindings);
        }
      } else if (
        (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") &&
        declaration.id
      ) {
        bindings.add(declaration.id.name);
      } else if (declaration?.type === "TSEnumDeclaration") {
        bindings.add(declaration.id.name);
      } else if (
        declaration?.type === "TSModuleDeclaration" &&
        declaration.id.type === "Identifier"
      ) {
        bindings.add(declaration.id.name);
      }
    }
  }
  return bindings;
}

function patternBinds(pattern: ESTree.Node, binding: string): boolean {
  const bindings = new Set<string>();
  collectPatternBindings(pattern, bindings);
  return bindings.has(binding);
}

function findVisibleConstInitializer(
  program: ESTree.Program,
  target: ESTree.Node,
  binding: string,
): ESTree.Node | undefined {
  const path = findAstPath(program, target);
  if (!path) return undefined;
  let initializer: ESTree.Node | undefined;
  for (const node of path) {
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      const parameterBindings = new Set<string>();
      for (const parameter of node.params) collectPatternBindings(parameter, parameterBindings);
      if (parameterBindings.has(binding)) initializer = undefined;
    }
    if (node.type === "FunctionExpression" && node.id?.name === binding) initializer = undefined;
    const statements =
      node.type === "Program" || node.type === "BlockStatement" ? node.body : undefined;
    if (!statements) continue;
    for (const statement of statements) {
      const declaration =
        statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (declaration?.type === "VariableDeclaration") {
        const declarator = declaration.declarations.find((candidate) =>
          patternBinds(candidate.id, binding),
        );
        if (!declarator) continue;
        initializer =
          declaration.kind === "const" && declarator.id.type === "Identifier"
            ? (unwrapExpression(declarator.init) ?? undefined)
            : undefined;
      } else if (
        ((declaration?.type === "FunctionDeclaration" ||
          declaration?.type === "ClassDeclaration") &&
          declaration.id?.name === binding) ||
        (declaration?.type === "TSEnumDeclaration" && declaration.id.name === binding) ||
        (declaration?.type === "TSModuleDeclaration" &&
          declaration.id.type === "Identifier" &&
          declaration.id.name === binding)
      ) {
        initializer = undefined;
      }
    }
  }
  return initializer;
}

function findVisibleDestructuredSource(
  program: ESTree.Program,
  target: ESTree.Node,
  binding: string,
): ESTree.Node | undefined {
  const path = findAstPath(program, target);
  if (!path) return undefined;
  let source: ESTree.Node | undefined;
  for (const node of path) {
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      if (node.params.some((parameter) => patternBinds(parameter, binding))) source = undefined;
    }
    if (node.type === "FunctionExpression" && node.id?.name === binding) source = undefined;
    const statements =
      node.type === "Program" || node.type === "BlockStatement" ? node.body : undefined;
    if (!statements) continue;
    for (const statement of statements) {
      const declaration =
        statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (declaration?.type === "VariableDeclaration") {
        const declarator = declaration.declarations.find((candidate) =>
          patternBinds(candidate.id, binding),
        );
        if (!declarator) continue;
        source =
          declaration.kind === "const" && declarator.id.type === "ObjectPattern"
            ? (unwrapExpression(declarator.init) ?? undefined)
            : undefined;
      } else if (
        ((declaration?.type === "FunctionDeclaration" ||
          declaration?.type === "ClassDeclaration") &&
          declaration.id?.name === binding) ||
        (declaration?.type === "TSEnumDeclaration" && declaration.id.name === binding) ||
        (declaration?.type === "TSModuleDeclaration" &&
          declaration.id.type === "Identifier" &&
          declaration.id.name === binding)
      ) {
        source = undefined;
      }
    }
  }
  return source;
}

function findVisiblePluginArray(
  program: ESTree.Program,
  config: AstObject,
  binding: string,
): (ESTree.ArrayExpression & AstNode) | undefined {
  const initializer = findVisibleConstInitializer(program, config, binding);
  return initializer?.type === "ArrayExpression"
    ? (initializer as ESTree.ArrayExpression & AstNode)
    : undefined;
}

function findPluginArray(
  config: AstObject,
  program: ESTree.Program,
): (ESTree.ArrayExpression & AstNode) | undefined {
  const plugins = findPluginsProperty(config);
  if (!plugins) return undefined;
  if (plugins.value.type === "ArrayExpression") return plugins.value;
  if (plugins.value.type !== "Identifier") return undefined;
  return findVisiblePluginArray(program, config, plugins.value.name);
}

function findCallInPluginArray(
  array: ESTree.ArrayExpression,
  matches: (call: ESTree.CallExpression) => boolean,
  program: ESTree.Program,
  allowConditional = false,
  scopeTarget: ESTree.Node = array,
  seenBindings = new Set<string>(),
): (ESTree.CallExpression & AstNode) | undefined {
  for (const element of array.elements) {
    const call = findCallInPluginExpression(
      element,
      matches,
      program,
      allowConditional,
      scopeTarget,
      seenBindings,
    );
    if (call) return call;
  }
  return undefined;
}

function findCallInPluginExpression(
  node: ESTree.Node | null,
  matches: (call: ESTree.CallExpression) => boolean,
  program: ESTree.Program,
  allowConditional: boolean,
  scopeTarget: ESTree.Node,
  seenBindings: Set<string>,
): (ESTree.CallExpression & AstNode) | undefined {
  const expression = unwrapExpression(node?.type === "SpreadElement" ? node.argument : node);
  if (expression?.type === "ArrayExpression") {
    return findCallInPluginArray(
      expression,
      matches,
      program,
      allowConditional,
      scopeTarget,
      seenBindings,
    );
  }
  if (expression?.type === "Identifier" && !seenBindings.has(expression.name)) {
    const initializer = findVisibleConstInitializer(program, scopeTarget, expression.name);
    if (!initializer) return undefined;
    const nextSeenBindings = new Set(seenBindings).add(expression.name);
    return findCallInPluginExpression(
      initializer,
      matches,
      program,
      allowConditional,
      scopeTarget,
      nextSeenBindings,
    );
  }
  if (allowConditional && expression?.type === "LogicalExpression") {
    if (expression.operator === "&&") {
      return findCallInPluginExpression(
        expression.right,
        matches,
        program,
        true,
        scopeTarget,
        seenBindings,
      );
    }
    return (
      findCallInPluginExpression(
        expression.left,
        matches,
        program,
        true,
        scopeTarget,
        seenBindings,
      ) ??
      findCallInPluginExpression(
        expression.right,
        matches,
        program,
        true,
        scopeTarget,
        seenBindings,
      )
    );
  }
  if (allowConditional && expression?.type === "ConditionalExpression") {
    return (
      findCallInPluginExpression(
        expression.consequent,
        matches,
        program,
        true,
        scopeTarget,
        seenBindings,
      ) ??
      findCallInPluginExpression(
        expression.alternate,
        matches,
        program,
        true,
        scopeTarget,
        seenBindings,
      )
    );
  }
  if (expression?.type === "CallExpression" && matches(expression)) {
    return expression as ESTree.CallExpression & AstNode;
  }
  return undefined;
}

function getVinextCacheSlot(
  call: (ESTree.CallExpression & AstNode) | undefined,
  name: "data" | "cdn",
): AstProperty | undefined {
  const firstArgument = call?.arguments[0];
  if (
    !firstArgument ||
    firstArgument.type === "SpreadElement" ||
    firstArgument.type !== "ObjectExpression"
  ) {
    return undefined;
  }
  const cache = findProperty(firstArgument as AstObject, "cache");
  if (cache?.value.type !== "ObjectExpression") return undefined;
  return findProperty(cache.value as AstObject, name);
}

function getVinextCacheOption(
  call: (ESTree.CallExpression & AstNode) | undefined,
): AstProperty | undefined {
  const firstArgument = call?.arguments[0];
  if (
    !firstArgument ||
    firstArgument.type === "SpreadElement" ||
    firstArgument.type !== "ObjectExpression"
  ) {
    return undefined;
  }
  return findProperty(firstArgument as AstObject, "cache");
}

function hasVinextCacheSlot(
  call: (ESTree.CallExpression & AstNode) | undefined,
  name: "data" | "cdn",
): boolean {
  return Boolean(getVinextCacheSlot(call, name));
}

function getVinextImageOptimizer(
  call: (ESTree.CallExpression & AstNode) | undefined,
): AstProperty | undefined {
  const firstArgument = call?.arguments[0];
  if (
    !firstArgument ||
    firstArgument.type === "SpreadElement" ||
    firstArgument.type !== "ObjectExpression"
  ) {
    return undefined;
  }
  const images = findProperty(firstArgument as AstObject, "images");
  if (images?.value.type !== "ObjectExpression") return undefined;
  return findProperty(images.value as AstObject, "optimizer");
}

function hasVinextPrerender(call: (ESTree.CallExpression & AstNode) | undefined): boolean {
  const firstArgument = call?.arguments[0];
  if (
    !firstArgument ||
    firstArgument.type === "SpreadElement" ||
    firstArgument.type !== "ObjectExpression"
  ) {
    return false;
  }
  return Boolean(findProperty(firstArgument as AstObject, "prerender"));
}

function isUsableImageOptimizer(property: AstProperty | undefined): boolean {
  if (!property) return false;
  const value = property.value as AstNode & { name?: string; value?: unknown };
  return !(
    (value.type === "Identifier" && value.name === "undefined") ||
    (value.type === "Literal" && value.value === null)
  );
}

function isImagesOptimizerCall(
  property: AstProperty | undefined,
  binding: string | undefined,
): boolean {
  return Boolean(
    property &&
    binding &&
    property.value.type === "CallExpression" &&
    property.value.callee.type === "Identifier" &&
    property.value.callee.name === binding,
  );
}

function ensureVinextCache(
  output: MagicString,
  config: AstObject,
  vinextBinding: string,
  additions: Array<{ name: "data" | "cdn"; expression: string }>,
  code: string,
  program: ESTree.Program,
  vinextMember?: string,
): void {
  if (additions.length === 0) return;
  const call = findPluginCall(config, vinextBinding, program, vinextMember);
  if (!call) return;
  if (call.arguments.length === 0) {
    output.appendLeft(
      call.end - 1,
      `{ cache: { ${additions.map(({ name, expression }) => `${name}: ${expression}`).join(", ")} } }`,
    );
    return;
  }
  const firstArgument = call.arguments[0];
  if (firstArgument.type === "SpreadElement" || firstArgument.type !== "ObjectExpression") {
    throw new Error(
      "The vinext() plugin options must be a static object for vinext init to add cache handlers.",
    );
  }
  const optionsObject = firstArgument as AstObject;
  const cache = findProperty(optionsObject, "cache");
  if (!cache) {
    insertObjectProperty(
      output,
      optionsObject,
      `    cache: {\n${additions.map(({ name, expression }) => `      ${name}: ${expression},`).join("\n")}\n    },`,
      code,
    );
    return;
  }
  if (cache.value.type !== "ObjectExpression") {
    throw new Error(
      "The vinext() cache option must be a static object for vinext init to add cache handlers.",
    );
  }
  const cacheObject = cache.value as AstObject;
  const missing = additions.filter(({ name }) => !findProperty(cacheObject, name));
  if (missing.length > 0) {
    insertObjectProperty(
      output,
      cacheObject,
      missing.map(({ name, expression }) => `      ${name}: ${expression},`).join("\n"),
      code,
    );
  }
}

function ensureVinextResponseStore(
  output: MagicString,
  config: AstObject,
  vinextBinding: string,
  expression: string | undefined,
  code: string,
  program: ESTree.Program,
  vinextMember?: string,
): void {
  if (!expression) return;
  const call = findPluginCall(config, vinextBinding, program, vinextMember);
  const firstArgument = call?.arguments[0];
  if (!call || !firstArgument || firstArgument.type === "SpreadElement") return;
  if (firstArgument.type !== "ObjectExpression") {
    throw new Error(
      "The vinext() plugin options must be a static object for vinext init to configure Workers Response Store.",
    );
  }
  const optionsObject = firstArgument as AstObject;
  const cache = findProperty(optionsObject, "cache");
  if (!cache) {
    insertObjectProperty(output, optionsObject, `    cache: ${expression},`, code);
  } else if (cache.value.type === "ObjectExpression" && cache.value.properties.length === 0) {
    output.overwrite((cache.value as AstNode).start, (cache.value as AstNode).end, expression);
  }
}

function ensureVinextImageOptimizer(
  output: MagicString,
  config: AstObject,
  vinextBinding: string,
  expression: string | undefined,
  code: string,
  program: ESTree.Program,
  vinextMember?: string,
): void {
  if (!expression) return;
  const call = findPluginCall(config, vinextBinding, program, vinextMember);
  if (!call) return;
  if (call.arguments.length === 0) {
    output.appendLeft(call.end - 1, `{ images: { optimizer: ${expression} } }`);
    return;
  }
  const firstArgument = call.arguments[0];
  if (firstArgument.type === "SpreadElement" || firstArgument.type !== "ObjectExpression") {
    throw new Error(
      "The vinext() plugin options must be a static object for vinext init to configure image optimization.",
    );
  }
  const optionsObject = firstArgument as AstObject;
  const images = findProperty(optionsObject, "images");
  if (!images) {
    insertObjectProperty(output, optionsObject, `    images: { optimizer: ${expression} },`, code);
    return;
  }
  if (images.value.type !== "ObjectExpression") {
    throw new Error(
      "The vinext() images option must be a static object for vinext init to add an image optimizer.",
    );
  }
  const imagesObject = images.value as AstObject;
  const optimizer = findProperty(imagesObject, "optimizer");
  if (!optimizer) {
    insertObjectProperty(output, imagesObject, `      optimizer: ${expression},`, code);
  } else {
    output.overwrite(
      (optimizer.value as AstNode).start,
      (optimizer.value as AstNode).end,
      expression,
    );
  }
}

function ensureVinextPrerender(
  output: MagicString,
  config: AstObject,
  vinextBinding: string,
  prerender: boolean | undefined,
  code: string,
  program: ESTree.Program,
  vinextMember?: string,
): void {
  if (!prerender) return;
  const call = findPluginCall(config, vinextBinding, program, vinextMember);
  if (!call || hasVinextPrerender(call)) return;
  if (call.arguments.length === 0) {
    output.appendLeft(call.end - 1, `{ prerender: { routes: "*" } }`);
    return;
  }
  const firstArgument = call.arguments[0];
  if (firstArgument.type === "SpreadElement" || firstArgument.type !== "ObjectExpression") {
    throw new Error(
      "The vinext() plugin options must be a static object for vinext init to add prerender config.",
    );
  }
  insertObjectProperty(output, firstArgument as AstObject, `    prerender: { routes: "*" },`, code);
}

function indentBlock(source: string, indent: string): string {
  return source
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

type PluginBindingReference = {
  binding: string;
  member?: string;
};

type PluginAddition = PluginBindingReference & {
  expression: string;
  equivalentBindings?: PluginBindingReference[];
  allowConditional?: boolean;
};

function expressionReferencesBinding(
  node: ESTree.Node,
  binding: string,
  program: ESTree.Program,
  scopeTarget: ESTree.Node,
  seenBindings = new Set<string>(),
): boolean {
  const expression = unwrapExpression(node);
  if (expression?.type !== "Identifier") return false;
  if (expression.name === binding) return true;
  if (seenBindings.has(expression.name)) return false;
  const initializer = findVisibleConstInitializer(program, scopeTarget, expression.name);
  return initializer
    ? expressionReferencesBinding(
        initializer,
        binding,
        program,
        scopeTarget,
        new Set(seenBindings).add(expression.name),
      )
    : false;
}

function calleeMatchesPluginAddition(
  node: ESTree.Node,
  addition: PluginBindingReference,
  program: ESTree.Program,
  scopeTarget: ESTree.Node,
  seenBindings = new Set<string>(),
): boolean {
  const callee = unwrapExpression(node);
  if (!callee) return false;
  if (addition.member === undefined) {
    return expressionReferencesBinding(
      callee,
      addition.binding,
      program,
      scopeTarget,
      seenBindings,
    );
  }
  if (callee.type === "Identifier") {
    if (seenBindings.has(callee.name)) return false;
    const initializer = findVisibleConstInitializer(program, scopeTarget, callee.name);
    return initializer
      ? calleeMatchesPluginAddition(
          initializer,
          addition,
          program,
          scopeTarget,
          new Set(seenBindings).add(callee.name),
        )
      : false;
  }
  return (
    callee.type === "MemberExpression" &&
    ((!callee.computed &&
      callee.property.type === "Identifier" &&
      callee.property.name === addition.member) ||
      (callee.computed &&
        callee.property.type === "Literal" &&
        callee.property.value === addition.member)) &&
    expressionReferencesBinding(callee.object, addition.binding, program, scopeTarget)
  );
}

function findUnshadowedTopLevelAliases(
  program: ESTree.Program,
  source: PluginBindingReference,
  excludedBindings: Set<string>,
): PluginBindingReference[] {
  const known = [source];
  let foundAlias = true;
  while (foundAlias) {
    foundAlias = false;
    for (const statement of program.body) {
      const declaration =
        statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
      for (const declarator of declaration.declarations) {
        if (declarator.id.type !== "Identifier") continue;
        const aliasName = declarator.id.name;
        if (known.some(({ binding }) => binding === aliasName)) continue;
        const initializer = unwrapExpression(declarator.init);
        const referenced = known.find(({ binding, member }) => {
          if (initializer?.type === "Identifier") return initializer.name === binding;
          return (
            member !== undefined &&
            initializer?.type === "MemberExpression" &&
            expressionReferencesBinding(initializer.object, binding, program, program) &&
            ((!initializer.computed &&
              initializer.property.type === "Identifier" &&
              initializer.property.name === member) ||
              (initializer.computed &&
                initializer.property.type === "Literal" &&
                initializer.property.value === member))
          );
        });
        if (!referenced) continue;
        known.push({
          binding: aliasName,
          member: initializer?.type === "Identifier" ? referenced.member : undefined,
        });
        foundAlias = true;
      }
    }
  }
  return known.filter(({ binding }) => !excludedBindings.has(binding));
}

function ensurePlugins(
  output: MagicString,
  config: AstObject,
  additions: PluginAddition[],
  code: string,
  program: ESTree.Program,
): void {
  const plugins = findPluginsProperty(config);
  if (!plugins) {
    const expressions = additions.map(({ expression }) => indentBlock(expression, "    "));
    insertObjectProperty(output, config, `  plugins: [\n${expressions.join(",\n")},\n  ],`, code);
    return;
  }
  const array = findPluginArray(config, program);
  if (!array) {
    throw new Error(
      "The Vite config's plugins option must be an array for vinext init to update it.",
    );
  }
  const propertyIndent =
    code
      .slice(0, (plugins as AstNode).start)
      .split("\n")
      .at(-1)
      ?.match(/^\s*/)?.[0] ?? "";
  const elementIndent = `${propertyIndent}  `;
  const missingExpressions: string[] = [];
  for (const addition of additions) {
    const alreadyConfigured = findCallInPluginArray(
      array,
      (expression) =>
        [addition, ...(addition.equivalentBindings ?? [])].some((reference) =>
          calleeMatchesPluginAddition(expression.callee, reference, program, array),
        ),
      program,
      addition.allowConditional,
    );
    if (!alreadyConfigured) missingExpressions.push(addition.expression);
  }
  if (missingExpressions.length === 0) return;

  const closingOffset = array.end - 1;
  const hasExistingElements = array.elements.some(Boolean);
  let finalElement: ESTree.ArrayExpressionElement | null = null;
  for (let index = array.elements.length - 1; index >= 0; index--) {
    if (array.elements[index] !== null) {
      finalElement = array.elements[index];
      break;
    }
  }
  const arraySuffix = code.slice(
    (finalElement as AstNode | undefined)?.end ?? array.start + 1,
    closingOffset,
  );
  const hasTrailingComma = endsWithCommaIgnoringWhitespaceAndComments(arraySuffix);
  const prefix = hasExistingElements && !hasTrailingComma ? "," : "";
  const inlineArray = !code.slice(array.start, array.end).includes("\n");
  if (inlineArray && hasExistingElements) {
    output.appendLeft(array.start + 1, `\n${elementIndent}`);
    let previousElement: ESTree.ArrayExpressionElement | null = null;
    for (const element of array.elements) {
      if (!element) continue;
      if (previousElement) {
        const gap = code.slice((previousElement as AstNode).end, (element as AstNode).start);
        const commaIndex = findCommaIgnoringComments(gap);
        if (commaIndex >= 0) {
          const trivia = [gap.slice(0, commaIndex), gap.slice(commaIndex + 1)]
            .map((part) => part.trim())
            .filter(Boolean);
          output.overwrite(
            (previousElement as AstNode).end,
            (element as AstNode).start,
            trivia.length > 0
              ? `,\n${elementIndent}${trivia.join(`\n${elementIndent}`)}\n${elementIndent}`
              : `,\n${elementIndent}`,
          );
        }
      }
      previousElement = element;
    }
  }
  output.appendLeft(
    closingOffset,
    `${prefix}\n${missingExpressions
      .map((expression) => indentBlock(expression, elementIndent))
      .join(",\n")},\n${propertyIndent}`,
  );
}

function prepareTailwindPlugin(
  program: ESTree.Program,
  output: MagicString,
  bindings: Set<string>,
  commonJs: boolean,
  shadowedBindings: Set<string>,
): PluginAddition {
  const tailwindLocal = allocateBinding(bindings, "tailwindcss");
  const requiredPackageBinding = commonJs
    ? findDefaultRequiredBinding(program, "@tailwindcss/vite")
    : undefined;
  const dynamicPackageBinding = commonJs
    ? findDynamicImportPluginBinding(program, "@tailwindcss/vite")
    : undefined;
  const packageBinding = commonJs
    ? (requiredPackageBinding ??
      (dynamicPackageBinding ? { binding: dynamicPackageBinding, namespace: false } : undefined))
    : findDefaultImportedBinding(program, "@tailwindcss/vite");
  const equivalentBindings = packageBinding
    ? findUnshadowedTopLevelAliases(
        program,
        {
          binding: packageBinding.binding,
          member: packageBinding.namespace ? "default" : undefined,
        },
        shadowedBindings,
      )
    : [];
  const existingAlias = equivalentBindings[0];
  const existingRequire = commonJs
    ? findDefaultRequiredBinding(program, "@tailwindcss/vite", shadowedBindings)
    : undefined;
  const existingDynamicImport = commonJs
    ? findDynamicImportPluginBinding(program, "@tailwindcss/vite", shadowedBindings)
    : undefined;
  const existingImport = commonJs
    ? undefined
    : findDefaultImportedBinding(program, "@tailwindcss/vite", shadowedBindings);
  let tailwindBinding: string;
  if (commonJs && !existingRequire && !existingDynamicImport && !existingAlias) {
    const offset = requireInsertionOffset(program);
    const sourceText = `const ${tailwindLocal} = () => import("@tailwindcss/vite").then(({ default: plugin }) => plugin());`;
    output.appendLeft(offset, offset === 0 ? `${sourceText}\n` : `\n${sourceText}`);
    tailwindBinding = tailwindLocal;
  } else {
    tailwindBinding = commonJs
      ? (existingRequire?.binding ??
        existingDynamicImport ??
        existingAlias?.binding ??
        tailwindLocal)
      : (existingImport?.binding ??
        existingAlias?.binding ??
        ensureDefaultImport(program, output, "@tailwindcss/vite", tailwindLocal, false));
  }
  const member =
    existingRequire?.namespace || existingImport?.namespace ? "default" : existingAlias?.member;
  return {
    expression: `${tailwindBinding}${member ? `.${member}` : ""}()`,
    binding: tailwindBinding,
    member,
    equivalentBindings,
    allowConditional: true,
  };
}

function ensureNativeAliases(
  output: MagicString,
  config: AstObject,
  modules: string[],
  pathBinding: string,
  code: string,
): void {
  if (modules.length === 0) return;
  const resolve = findProperty(config, "resolve");
  if (resolve && resolve.value.type !== "ObjectExpression") {
    throw new Error(
      "The Vite config's resolve option must be an object for vinext init to update it.",
    );
  }
  const resolveObject = resolve?.value as AstObject | undefined;
  const alias = resolveObject ? findProperty(resolveObject, "alias") : undefined;
  if (alias && alias.value.type !== "ObjectExpression") {
    throw new Error(
      "The Vite config's resolve.alias option must be an object for vinext init to update it.",
    );
  }
  const aliasLines = modules.map(
    (moduleName) =>
      `      ${JSON.stringify(moduleName)}: ${pathBinding}.resolve(__dirname, "empty-stub.js"),`,
  );
  if (!resolveObject) {
    insertObjectProperty(
      output,
      config,
      `  resolve: {\n    alias: {\n${aliasLines.join("\n")}\n    },\n  },`,
      code,
    );
    return;
  }
  if (!alias) {
    insertObjectProperty(
      output,
      resolveObject,
      `    alias: {\n${aliasLines.join("\n")}\n    },`,
      code,
    );
    return;
  }
  const aliasObject = alias.value as AstObject;
  const existingAliases = new Set(
    aliasObject.properties.flatMap((property) =>
      property.type === "Property" && propertyName(property) ? [propertyName(property)!] : [],
    ),
  );
  const missingLines = aliasLines.filter((_, index) => !existingAliases.has(modules[index]));
  if (missingLines.length > 0) {
    insertObjectProperty(output, aliasObject, missingLines.join("\n"), code);
  }
}

export function updateViteConfigForTailwind(filePath: string, code: string): string {
  const program = parseViteConfig(filePath, code);
  const config = findConfigObject(program);
  if (!config) {
    throw new Error(
      `Could not find a static Vite config object in ${path.basename(filePath)}. Use an object export or defineConfig({...}) so vinext init can update it.`,
    );
  }
  assertConfigPropertiesAreStatic(program, config);
  const pluginArray = findPluginArray(config, program);
  assertPluginArrayIsStatic(program, pluginArray);
  const output = new MagicString(code);
  const commonJs = usesCommonJsViteConfig(filePath, code);
  const bindings = collectTopLevelBindings(program);
  const shadowedBindings = collectShadowedBindings(program, pluginArray ?? config);
  for (const binding of shadowedBindings) bindings.add(binding);
  ensurePlugins(
    output,
    config,
    [prepareTailwindPlugin(program, output, bindings, commonJs, shadowedBindings)],
    code,
    program,
  );
  return output.toString();
}

export function updateViteConfigForCloudflare(
  filePath: string,
  code: string,
  options: {
    isAppRouter: boolean;
    hasTailwindV4?: boolean;
    nativeModulesToStub: string[];
    cache?: CloudflareInitOptions;
    imagesBinding?: string;
    versionMetadataBinding?: string;
    prerender?: boolean;
  },
): string {
  const program = parseViteConfig(filePath, code);
  const cacheOptions = options.cache ?? DEFAULT_CLOUDFLARE_INIT_OPTIONS;
  const config = findConfigObject(program);
  if (!config) {
    throw new Error(
      `Could not find a static Vite config object in ${path.basename(filePath)}. Use an object export or defineConfig({...}) so vinext init can update it.`,
    );
  }
  assertConfigPropertiesAreStatic(program, config);
  const pluginArray = findPluginArray(config, program);
  assertPluginArrayIsStatic(program, pluginArray);

  const output = new MagicString(code);
  const commonJs = usesCommonJsViteConfig(filePath, code);
  const bindings = collectTopLevelBindings(program);
  const shadowedBindings = collectShadowedBindings(program, pluginArray ?? config);
  for (const binding of shadowedBindings) bindings.add(binding);
  const importedVinext = commonJs
    ? findDefaultRequiredBinding(program, "vinext")
    : findDefaultImportedBinding(program, "vinext");
  const vinextPackageReferences: PluginBindingReference[] = importedVinext
    ? [
        {
          binding: importedVinext.binding,
          member: !commonJs && importedVinext.namespace ? "default" : undefined,
        },
        ...(commonJs && importedVinext.namespace
          ? [{ binding: importedVinext.binding, member: "default" }]
          : []),
      ]
    : [];
  const vinextEquivalentBindings = vinextPackageReferences
    .flatMap((reference) => findUnshadowedTopLevelAliases(program, reference, shadowedBindings))
    .filter(
      (reference, index, references) =>
        references.findIndex(
          (candidate) =>
            candidate.binding === reference.binding && candidate.member === reference.member,
        ) === index,
    );
  const configuredVinextAlias = vinextEquivalentBindings.find(({ binding, member }) =>
    findPluginCall(config, binding, program, member),
  );
  const directVinext = commonJs
    ? findRequiredBinding(program, "vinext", "default", shadowedBindings)
    : findDefaultImportedBinding(program, "vinext", shadowedBindings);
  const directVinextReference =
    typeof directVinext === "string"
      ? { binding: directVinext }
      : directVinext
        ? {
            binding: directVinext.binding,
            member: directVinext.namespace ? "default" : undefined,
          }
        : undefined;
  const existingVinextReference =
    configuredVinextAlias ?? directVinextReference ?? vinextEquivalentBindings[0];
  const vinextLocal = existingVinextReference?.binding ?? allocateBinding(bindings, "vinext");
  const vinextBinding =
    existingVinextReference?.binding ??
    (commonJs
      ? ensureDefaultRequire(program, output, "vinext", vinextLocal, false)
      : ensureDefaultImport(program, output, "vinext", vinextLocal, false));
  const vinextMember = existingVinextReference?.member;
  const vinextCallee = `${vinextBinding}${vinextMember ? `.${vinextMember}` : ""}`;
  const existingVinextCall = findPluginCall(config, vinextBinding, program, vinextMember);
  const existingImageOptimizer = getVinextImageOptimizer(existingVinextCall);
  const needsPrerender = Boolean(options.prerender && !hasVinextPrerender(existingVinextCall));
  const configureCaches = options.cache !== undefined;
  const existingCache = getVinextCacheOption(existingVinextCall);
  if (configureCaches && existingCache) {
    const cacheObject =
      existingCache.value.type === "ObjectExpression"
        ? (existingCache.value as AstObject)
        : undefined;
    if (
      (!cacheObject && cacheOptions.cdnCache !== "response-store") ||
      (cacheObject &&
        (cacheOptions.cdnCache === "none" || cacheOptions.cdnCache === "data-cache") &&
        findProperty(cacheObject, "cdn")) ||
      (cacheObject && cacheOptions.dataCache === "none" && findProperty(cacheObject, "data"))
    ) {
      throw new Error(
        "The existing vinext() cache configuration does not match the selected cache options. Remove it before rerunning vinext init.",
      );
    }
  }
  const cacheAdditions: Array<{ name: "data" | "cdn"; expression: string }> = [];
  let responseStoreExpression: string | undefined;
  let responseStoreBinding = "responseStoreAdapter";
  if (configureCaches && cacheOptions.cdnCache === "response-store") {
    const source = "@vinext/cloudflare/cache/response-store-adapter";
    const imported = "responseStoreAdapter";
    const existing = commonJs
      ? findRequiredBinding(program, source, imported, shadowedBindings)
      : findImportedBinding(program, source, imported, shadowedBindings);
    const cache = getVinextCacheOption(existingVinextCall);
    const alreadyConfigured = Boolean(
      existing &&
      cache?.value.type === "CallExpression" &&
      cache.value.callee.type === "Identifier" &&
      cache.value.callee.name === existing,
    );
    if (
      cache &&
      !alreadyConfigured &&
      !(cache.value.type === "ObjectExpression" && cache.value.properties.length === 0)
    ) {
      throw new Error(
        "The vinext() cache option is already configured. Remove it before configuring Workers Response Store.",
      );
    }
    if (
      !cache ||
      alreadyConfigured ||
      (cache.value.type === "ObjectExpression" && cache.value.properties.length === 0)
    ) {
      const local = existing ?? allocateBinding(bindings, imported);
      const binding =
        existing ??
        (commonJs
          ? ensureNamedRequire(program, output, source, imported, local, false)
          : ensureNamedImport(program, output, source, imported, local, false));
      responseStoreBinding = binding;
      responseStoreExpression = `${binding}(${cacheOptions.responseStoreMode === "self-contained" ? '{ mode: "self-contained" }' : ""})`;
      if (alreadyConfigured && cache) {
        const call = cache.value as ESTree.CallExpression & AstNode;
        const argument = call.arguments[0];
        const mode = cacheOptions.responseStoreMode ?? "service-binding";
        if (!argument) {
          if (mode === "self-contained") {
            output.appendLeft(call.end - 1, '{ mode: "self-contained" }');
          }
        } else if (argument.type === "ObjectExpression") {
          const optionsObject = argument as AstObject;
          const existingMode = findProperty(optionsObject, "mode");
          if (existingMode) {
            if (existingMode.shorthand) {
              output.overwrite(
                (existingMode as AstNode).start,
                (existingMode as AstNode).end,
                `mode: ${JSON.stringify(mode)}`,
              );
            } else {
              output.overwrite(
                (existingMode.value as AstNode).start,
                (existingMode.value as AstNode).end,
                JSON.stringify(mode),
              );
            }
          } else if (mode === "self-contained") {
            insertObjectProperty(output, optionsObject, '      mode: "self-contained",', code);
          }
        } else {
          throw new Error(
            "responseStoreAdapter() options must be a static object for vinext init to update its mode.",
          );
        }
        responseStoreExpression = undefined;
      }
    }
  }
  if (cacheOptions.dataCache === "kv" && !hasVinextCacheSlot(existingVinextCall, "data")) {
    const existing = commonJs
      ? findRequiredBinding(
          program,
          "@vinext/cloudflare/cache/kv-data-adapter",
          "kvDataAdapter",
          shadowedBindings,
        )
      : findImportedBinding(
          program,
          "@vinext/cloudflare/cache/kv-data-adapter",
          "kvDataAdapter",
          shadowedBindings,
        );
    const local = existing ?? allocateBinding(bindings, "kvDataAdapter");
    const binding =
      existing ??
      (commonJs
        ? ensureNamedRequire(
            program,
            output,
            "@vinext/cloudflare/cache/kv-data-adapter",
            "kvDataAdapter",
            local,
            false,
          )
        : ensureNamedImport(
            program,
            output,
            "@vinext/cloudflare/cache/kv-data-adapter",
            "kvDataAdapter",
            local,
            false,
          ));
    cacheAdditions.push({ name: "data", expression: `${binding}()` });
  }
  if (configureCaches && cacheOptions.cdnCache === "workers-cache") {
    const imported = "cdnAdapter";
    const source = "@vinext/cloudflare/cache/cdn-adapter";
    const existing = commonJs
      ? findRequiredBinding(program, source, imported, shadowedBindings)
      : findImportedBinding(program, source, imported, shadowedBindings);
    const existingCdnSlot = getVinextCacheSlot(existingVinextCall, "cdn");
    const existingUsesCloudflareAdapter = Boolean(
      existing &&
      existingCdnSlot?.value.type === "CallExpression" &&
      existingCdnSlot.value.callee.type === "Identifier" &&
      existingCdnSlot.value.callee.name === existing,
    );
    // An existing custom CDN adapter is user-owned; init must not replace it.
    if (!existingCdnSlot || existingUsesCloudflareAdapter) {
      const local = existing ?? allocateBinding(bindings, imported);
      const binding =
        existing ??
        (commonJs
          ? ensureNamedRequire(program, output, source, imported, local, false)
          : ensureNamedImport(program, output, source, imported, local, false));
      const adapterOptions =
        options.versionMetadataBinding &&
        options.versionMetadataBinding !== DEFAULT_VERSION_METADATA_BINDING
          ? `{ versionMetadataBinding: ${JSON.stringify(options.versionMetadataBinding)} }`
          : "";
      const expression = `${binding}(${adapterOptions})`;
      if (existingCdnSlot) {
        output.overwrite(
          (existingCdnSlot.value as AstNode).start,
          (existingCdnSlot.value as AstNode).end,
          expression,
        );
      } else {
        cacheAdditions.push({ name: "cdn", expression });
      }
    }
  }
  let imageOptimizerExpression: string | undefined;
  if (cacheOptions.imageOptimization === "cloudflare-images") {
    const source = "@vinext/cloudflare/images/images-optimizer";
    const imported = "imagesOptimizer";
    const existing = commonJs
      ? findRequiredBinding(program, source, imported, shadowedBindings)
      : findImportedBinding(program, source, imported, shadowedBindings);
    if (
      !isUsableImageOptimizer(existingImageOptimizer) ||
      isImagesOptimizerCall(existingImageOptimizer, existing)
    ) {
      const local = existing ?? allocateBinding(bindings, imported);
      const imageBinding =
        existing ??
        (commonJs
          ? ensureNamedRequire(program, output, source, imported, local, false)
          : ensureNamedImport(program, output, source, imported, local, false));
      const bindingOption =
        options.imagesBinding && options.imagesBinding !== "IMAGES"
          ? `{ binding: ${JSON.stringify(options.imagesBinding)} }`
          : "";
      imageOptimizerExpression = `${imageBinding}(${bindingOption})`;
    }
  }
  const cloudflarePackageBinding = commonJs
    ? findRequiredBinding(program, "@cloudflare/vite-plugin", "cloudflare")
    : findImportedBinding(program, "@cloudflare/vite-plugin", "cloudflare");
  const cloudflareEquivalentBindings = cloudflarePackageBinding
    ? findUnshadowedTopLevelAliases(
        program,
        { binding: cloudflarePackageBinding },
        shadowedBindings,
      )
    : [];
  const configuredCloudflareAlias = cloudflareEquivalentBindings.find(({ binding }) =>
    findPluginCall(config, binding, program),
  );
  const directCloudflareBinding = commonJs
    ? findRequiredBinding(program, "@cloudflare/vite-plugin", "cloudflare", shadowedBindings)
    : findImportedBinding(program, "@cloudflare/vite-plugin", "cloudflare", shadowedBindings);
  const existingCloudflareBinding =
    directCloudflareBinding ??
    configuredCloudflareAlias?.binding ??
    cloudflareEquivalentBindings[0]?.binding;
  const cloudflareLocal = existingCloudflareBinding ?? allocateBinding(bindings, "cloudflare");
  const cloudflareBinding =
    existingCloudflareBinding ??
    (commonJs
      ? ensureNamedRequire(
          program,
          output,
          "@cloudflare/vite-plugin",
          "cloudflare",
          cloudflareLocal,
          false,
        )
      : ensureNamedImport(
          program,
          output,
          "@cloudflare/vite-plugin",
          "cloudflare",
          cloudflareLocal,
          false,
        ));
  let tailwindPlugin: PluginAddition | undefined;
  if (options.hasTailwindV4) {
    tailwindPlugin = prepareTailwindPlugin(program, output, bindings, commonJs, shadowedBindings);
  }
  ensurePlugins(
    output,
    config,
    [
      ...(tailwindPlugin ? [tailwindPlugin] : []),
      {
        expression: existingVinextCall
          ? `${vinextCallee}()`
          : options.cache || options.prerender
            ? vinextExpression(
                cacheOptions,
                vinextCallee,
                imageOptimizerExpression?.slice(0, imageOptimizerExpression.indexOf("(")) ||
                  "imagesOptimizer",
                options.imagesBinding,
                options.prerender,
                options.versionMetadataBinding,
                responseStoreBinding,
                cacheAdditions,
              )
            : `${vinextCallee}()`,
        binding: vinextBinding,
        member: vinextMember,
        equivalentBindings: vinextEquivalentBindings,
      },
      {
        expression: cloudflarePluginExpression(options.isAppRouter, cloudflareBinding),
        binding: cloudflareBinding,
        equivalentBindings: cloudflareEquivalentBindings,
      },
    ],
    code,
    program,
  );
  ensureCloudflareViteEnvironment(
    output,
    config,
    cloudflareBinding,
    options.isAppRouter,
    code,
    program,
  );
  if (existingVinextCall) {
    if (
      existingVinextCall.arguments.length === 0 &&
      (responseStoreExpression ||
        cacheAdditions.length > 0 ||
        imageOptimizerExpression ||
        needsPrerender)
    ) {
      const properties: string[] = [];
      if (responseStoreExpression) {
        properties.push(`cache: ${responseStoreExpression}`);
      } else if (cacheAdditions.length > 0) {
        properties.push(
          `cache: { ${cacheAdditions.map(({ name, expression }) => `${name}: ${expression}`).join(", ")} }`,
        );
      }
      if (imageOptimizerExpression) {
        properties.push(`images: { optimizer: ${imageOptimizerExpression} }`);
      }
      if (needsPrerender) {
        properties.push(`prerender: { routes: "*" }`);
      }
      const plugins = findPluginsProperty(config);
      const propertyIndent = plugins
        ? (code
            .slice(0, (plugins as AstNode).start)
            .split("\n")
            .at(-1)
            ?.match(/^\s*/)?.[0] ?? "")
        : "";
      const closingIndent = `${propertyIndent}  `;
      const propertyEntryIndent = `${closingIndent}  `;
      output.appendLeft(
        existingVinextCall.end - 1,
        `{\n${propertyEntryIndent}${properties.join(`,\n${propertyEntryIndent}`)},\n${closingIndent}}`,
      );
    } else {
      ensureVinextResponseStore(
        output,
        config,
        vinextBinding,
        responseStoreExpression,
        code,
        program,
        vinextMember,
      );
      ensureVinextCache(output, config, vinextBinding, cacheAdditions, code, program, vinextMember);
      ensureVinextImageOptimizer(
        output,
        config,
        vinextBinding,
        imageOptimizerExpression,
        code,
        program,
        vinextMember,
      );
      ensureVinextPrerender(
        output,
        config,
        vinextBinding,
        options.prerender,
        code,
        program,
        vinextMember,
      );
    }
  }

  if (options.nativeModulesToStub.length > 0) {
    const existingPathBinding = commonJs
      ? findRequiredBinding(program, "node:path", "default", shadowedBindings)
      : program.body
          .filter(
            (statement): statement is ESTree.ImportDeclaration =>
              statement.type === "ImportDeclaration",
          )
          .filter((statement) => statement.source.value === "node:path")
          .flatMap((statement) => statement.specifiers)
          .find(
            (specifier): specifier is ESTree.ImportDefaultSpecifier =>
              specifier.type === "ImportDefaultSpecifier" &&
              !shadowedBindings.has(specifier.local.name),
          )?.local.name;
    const pathLocal = existingPathBinding ?? allocateBinding(bindings, "path");
    const pathBinding =
      existingPathBinding ??
      (commonJs
        ? ensureDefaultRequire(program, output, "node:path", pathLocal, false)
        : ensureDefaultImport(program, output, "node:path", pathLocal, false));
    ensureNativeAliases(output, config, options.nativeModulesToStub, pathBinding, code);
  }

  return output.toString();
}

export function usesCommonJsViteConfig(filePath: string, code: string): boolean {
  if (/\.(?:cjs|cts)$/.test(filePath)) return true;
  const program = parseViteConfig(filePath, code);
  return program.body.some(
    (statement) =>
      statement.type === "ExpressionStatement" &&
      statement.expression.type === "AssignmentExpression" &&
      statement.expression.left.type === "MemberExpression" &&
      statement.expression.left.object.type === "Identifier" &&
      statement.expression.left.object.name === "module" &&
      statement.expression.left.property.type === "Identifier" &&
      statement.expression.left.property.name === "exports",
  );
}
