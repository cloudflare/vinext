import fs from "node:fs";
import path from "node:path";
import MagicString from "magic-string";
import { parseSync } from "vite";
import type { ESTree } from "vite";
import type { CloudflareInitOptions, InitImageOptimization } from "./init-platform.js";

export type CloudflareProjectInfo = {
  root: string;
  projectName: string;
  hasISR: boolean;
  hasMDX: boolean;
  nativeModulesToStub: string[];
};

const DEFAULT_CLOUDFLARE_INIT_OPTIONS: CloudflareInitOptions = {
  dataCache: "kv",
  cdnCache: "workers",
  imageOptimization: "cloudflare-images",
};

// Cloudflare deployment scaffolding belongs to `vinext init`.
export function generateWranglerConfig(
  info: CloudflareProjectInfo,
  options: CloudflareInitOptions = DEFAULT_CLOUDFLARE_INIT_OPTIONS,
  today = new Date().toISOString().split("T")[0],
): string {
  const workerEntry =
    !fs.existsSync(path.join(info.root, "worker", "index.ts")) &&
    fs.existsSync(path.join(info.root, "worker", "index.js"))
      ? "./worker/index.js"
      : "./worker/index.ts";

  const config: Record<string, unknown> = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: info.projectName,
    compatibility_date: today,
    compatibility_flags: ["nodejs_compat"],
    main: workerEntry,
    assets: {
      // Wrangler 4.69+ requires `directory` when `assets` is an object.
      // The @cloudflare/vite-plugin always writes static assets to dist/client/.
      directory: "dist/client",
      not_found_handling: "none",
      // Expose static assets to the Worker via env.ASSETS so the image
      // optimization handler can fetch source images programmatically.
      binding: "ASSETS",
    },
  };

  if (options.imageOptimization === "cloudflare-images") {
    config.images = { binding: "IMAGES" };
  }

  if (options.dataCache === "kv" || options.cdnCache === "kv") {
    config.kv_namespaces = [
      {
        binding: "VINEXT_KV_CACHE",
        id: "<your-kv-namespace-id>",
      },
    ];
  }

  return JSON.stringify(config, null, 2) + "\n";
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
  const needsComma = !/,\s*$/.test(before) && !/{\s*$/.test(before);
  return `${before}${needsComma ? "," : ""}\n${property}\n${code.slice(closing)}`;
}

export function updateWranglerConfigForCloudflare(
  code: string,
  options: CloudflareInitOptions,
): string {
  try {
    JSON.parse(stripJsonComments(code));
  } catch (cause) {
    throw new Error("Could not parse the existing Wrangler JSON/JSONC config.", { cause });
  }
  let output = code;
  if (options.imageOptimization === "cloudflare-images") {
    const imagesProperty = findTopLevelJsonProperty(output, "images");
    if (!imagesProperty) {
      output = appendTopLevelJsonProperty(output, '  "images": { "binding": "IMAGES" },');
    } else {
      const images = JSON.parse(
        stripJsonComments(output.slice(imagesProperty.valueStart, imagesProperty.valueEnd)),
      ) as { binding?: unknown } | null;
      if (!images || typeof images.binding !== "string" || images.binding.length === 0) {
        output = `${output.slice(0, imagesProperty.valueStart)}{ "binding": "IMAGES" }${output.slice(imagesProperty.valueEnd)}`;
      }
    }
  }
  if (options.dataCache === "kv" || options.cdnCache === "kv") {
    const kvProperty = findTopLevelJsonProperty(output, "kv_namespaces");
    if (!kvProperty) {
      output = appendTopLevelJsonProperty(
        output,
        '  "kv_namespaces": [{ "binding": "VINEXT_KV_CACHE", "id": "<your-kv-namespace-id>" }],',
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
  return output;
}

export function updateWranglerTomlForCloudflare(
  code: string,
  options: CloudflareInitOptions,
): string {
  let output = code;
  const tableStart = output.search(/^\s*\[/m);
  const topLevel = tableStart < 0 ? output : output.slice(0, tableStart);
  if (
    options.imageOptimization === "cloudflare-images" &&
    !/^\s*images\s*=\s*\{[^\n]*\bbinding\s*=\s*["'][^"']+["']/m.test(topLevel) &&
    !getWranglerTomlImagesBinding(output)
  ) {
    const insertion = tableStart < 0 ? output.length : tableStart;
    const before = output.slice(0, insertion);
    const after = output.slice(insertion);
    const prefix = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
    const suffix = after.length > 0 && !after.startsWith("\n") ? "\n" : "";
    output = `${before}${prefix}images = { binding = "IMAGES" }\n${suffix}${after}`;
  }
  if (
    (options.dataCache === "kv" || options.cdnCache === "kv") &&
    !hasWranglerTomlKvBinding(output, "VINEXT_KV_CACHE")
  ) {
    if (output.length > 0 && !output.endsWith("\n")) output += "\n";
    if (output.length > 0 && !output.endsWith("\n\n")) output += "\n";
    output += '[[kv_namespaces]]\nbinding = "VINEXT_KV_CACHE"\nid = "<your-kv-namespace-id>"\n';
  }
  return output;
}

function hasWranglerTomlKvBinding(code: string, binding: string): boolean {
  const tableStart = code.search(/^\s*\[/m);
  const topLevel = tableStart < 0 ? code : code.slice(0, tableStart);
  const inlineNamespaces = topLevel.match(/^\s*kv_namespaces\s*=\s*\[([\s\S]*?)\]\s*$/m)?.[1];
  if (
    inlineNamespaces &&
    new RegExp(`\\bbinding\\s*=\\s*["']${binding}["']`).test(inlineNamespaces)
  ) {
    return true;
  }
  const lines = code.split("\n");
  let inKvNamespace = false;
  for (const line of lines) {
    const table = line.match(/^\s*(\[\[?[^\]]+\]\]?)/)?.[1];
    if (table) inKvNamespace = /^\[\[\s*kv_namespaces\s*\]\]$/.test(table);
    if (
      inKvNamespace &&
      new RegExp(`^\\s*binding\\s*=\\s*["']${binding}["']\\s*(?:#.*)?$`).test(line)
    ) {
      return true;
    }
  }
  return false;
}

function getWranglerTomlTableBinding(code: string, tableName: string): string | undefined {
  const lines = code.split("\n");
  let inTable = false;
  for (const line of lines) {
    const table = line.match(/^\s*\[\s*([^\]]+)\s*\]\s*(?:#.*)?$/)?.[1];
    if (table) inTable = table.trim() === tableName;
    if (!inTable) continue;
    const binding = line.match(/^\s*binding\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/)?.[1];
    if (binding) return binding;
  }
  return undefined;
}

function getWranglerTomlImagesBinding(code: string): string | undefined {
  const dotted = code.match(/^\s*images\.binding\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m)?.[1];
  return dotted ?? getWranglerTomlTableBinding(code, "images");
}

export function getWranglerImagesBinding(code: string, format: "json" | "toml"): string {
  if (format === "toml") {
    const structuredBinding = getWranglerTomlImagesBinding(code);
    if (structuredBinding) return structuredBinding;
    return (
      code.match(/^\s*images\s*=\s*\{[^\n]*\bbinding\s*=\s*["']([^"']+)["']/m)?.[1] ?? "IMAGES"
    );
  }
  const property = findTopLevelJsonProperty(code, "images");
  if (!property) return "IMAGES";
  const images = JSON.parse(
    stripJsonComments(code.slice(property.valueStart, property.valueEnd)),
  ) as { binding?: unknown } | null;
  return images && typeof images.binding === "string" && images.binding.length > 0
    ? images.binding
    : "IMAGES";
}

/** Generate worker/index.ts for App Router */
export function generateAppRouterWorkerEntry(
  imageOptimization: InitImageOptimization = "cloudflare-images",
  imagesBinding = "IMAGES",
): string {
  if (imageOptimization === "none") {
    return `import handler from "vinext/server/app-router-entry";\n\nexport default handler;\n`;
  }
  return `/**
 * Cloudflare Worker entry point — auto-generated by vinext.
 * Edit freely or delete to regenerate with vinext init.
 *
 * Cache backends (data + page ISR) are configured declaratively in
 * vite.config via the vinext({ cache }) option.
 *
 * For apps without image optimization, you can use vinext/server/app-router-entry
 * directly in wrangler.jsonc: "main": "vinext/server/app-router-entry"
 */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES, isImageOptimizationPath } from "vinext/server/image-optimization";
import type { ImageConfig } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

const imageConfig: ImageConfig = {
  deviceSizes: JSON.parse(
    process.env.__VINEXT_IMAGE_DEVICE_SIZES ?? JSON.stringify(DEFAULT_DEVICE_SIZES),
  ),
  imageSizes: JSON.parse(
    process.env.__VINEXT_IMAGE_SIZES ?? JSON.stringify(DEFAULT_IMAGE_SIZES),
  ),
  qualities: JSON.parse(process.env.__VINEXT_IMAGE_QUALITIES ?? "null") ?? undefined,
  dangerouslyAllowSVG: process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_SVG === "true",
};

interface Env {
  ASSETS: Fetcher;
  ${imagesBinding}: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Image optimization via Cloudflare Images binding.
    // The parseImageParams validation inside handleImageOptimization
    // normalizes backslashes and validates the origin hasn't changed.
    if (isImageOptimizationPath(url.pathname)) {
      const allowedWidths = [
        ...(imageConfig.deviceSizes ?? DEFAULT_DEVICE_SIZES),
        ...(imageConfig.imageSizes ?? DEFAULT_IMAGE_SIZES),
      ];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.${imagesBinding}.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths, imageConfig);
    }

    // Delegate everything else to vinext, forwarding ctx so that
    // ctx.waitUntil() is available to background cache writes and
    // other deferred work via getRequestExecutionContext().
    return handler.fetch(request, env, ctx);
  },
};
`;
}

/** Generate worker/index.ts for Pages Router */
export function generatePagesRouterWorkerEntry(
  imageOptimization: InitImageOptimization = "cloudflare-images",
  imagesBinding = "IMAGES",
): string {
  const source = `/**
 * Cloudflare Worker entry point -- auto-generated by vinext.
 * Edit freely or delete to regenerate with vinext init.
 */
import { fetchWorkerFilesystemRoute, runPagesRequest, wrapMiddlewareWithBasePath } from "vinext/server/pages-request-pipeline";
import type { PagesPipelineDeps } from "vinext/server/pages-request-pipeline";
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES, isImageOptimizationPath } from "vinext/server/image-optimization";
import type { ImageConfig } from "vinext/server/image-optimization";
import { cloneRequestWithHeaders, cloneRequestWithUrl, filterInternalHeaders, isOpenRedirectShaped } from "vinext/server/request-pipeline";
import { notFoundStaticAssetResponse } from "vinext/server/http-error-responses";
import { finalizeMissingStaticAssetResponse } from "vinext/server/worker-utils";
import { assetPrefixPathname, isNextStaticPath } from "vinext/utils/asset-prefix";
import { hasBasePath, stripBasePath } from "vinext/utils/base-path";

// @ts-expect-error -- virtual module resolved by vinext at build time
import { renderPage, handleApiRoute, runMiddleware, normalizeDataRequest, vinextConfig, matchPageRoute } from "virtual:vinext-server-entry";
// @ts-expect-error -- virtual module resolved by vinext at build time
import { registerConfiguredCacheAdapters } from "virtual:vinext-cache-adapters";

interface Env {
  ASSETS: Fetcher;
  ${imagesBinding}: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Extract config values (embedded at build time in the server entry)
const basePath: string = vinextConfig?.basePath ?? "";
const assetPathPrefix: string = assetPrefixPathname(vinextConfig?.assetPrefix ?? "");
const trailingSlash: boolean = vinextConfig?.trailingSlash ?? false;
const i18nConfig = vinextConfig?.i18n ?? null;
const configRedirects = vinextConfig?.redirects ?? [];
const configRewrites = vinextConfig?.rewrites ?? { beforeFiles: [], afterFiles: [], fallback: [] };
const configHeaders = vinextConfig?.headers ?? [];
const imageConfig: ImageConfig | undefined = vinextConfig?.images ? {
  qualities: vinextConfig.images.qualities,
  dangerouslyAllowSVG: vinextConfig.images.dangerouslyAllowSVG,
  dangerouslyAllowLocalIP: vinextConfig.images.dangerouslyAllowLocalIP,
  contentDispositionType: vinextConfig.images.contentDispositionType,
  contentSecurityPolicy: vinextConfig.images.contentSecurityPolicy,
} : undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Pass the Worker \`env\` so binding-backed adapters (e.g. KV) resolve.
    registerConfiguredCacheAdapters(env);
    try {
      const url = new URL(request.url);
      let pathname = url.pathname;

      // Block protocol-relative URL open redirects in all shapes:
      //   literal  //evil.com, /\\\\evil.com
      //   encoded  /%5Cevil.com, /%2F/evil.com
      // Browsers normalize backslash to forward slash, and they percent-decode
      // Location headers, so an encoded backslash in a downstream 308 redirect
      // would also navigate to the attacker's origin.
      if (isOpenRedirectShaped(pathname)) {
        return new Response("This page could not be found", { status: 404 });
      }

      // Valid assets are served by Cloudflare's ASSETS binding before the
      // worker runs. Missing asset-shaped requests still need to reach
      // middleware so it can rewrite or respond; a final 404 is converted
      // back to Next.js's canonical plain-text static-file response below.
      const missingBuildAsset = isNextStaticPath(pathname, basePath, assetPathPrefix);

      // Strip internal headers from inbound requests so they cannot be
      // forged to influence routing or impersonate internal state.
      // Request.headers is immutable in Workers, so build a clean copy.
      {
        const filteredHeaders = filterInternalHeaders(request.headers);
        request = cloneRequestWithHeaders(request, filteredHeaders);
      }

      // ── 1. Strip basePath ─────────────────────────────────────────
      // Track basePath presence on the original request so the matcher
      // gating below can distinguish requests inside basePath (default
      // rules apply) from requests outside it (only opt-out rules apply).
      const hadBasePath = !basePath || hasBasePath(pathname, basePath);
      {
        const stripped = stripBasePath(pathname, basePath);
        if (stripped !== pathname) {
          const strippedUrl = new URL(request.url);
          strippedUrl.pathname = stripped;
          request = cloneRequestWithUrl(request, strippedUrl.toString());
          pathname = stripped;
        }
      }

      const dataNorm = normalizeDataRequest(request);
      if (dataNorm.notFoundResponse) return dataNorm.notFoundResponse;
      const isDataReq = dataNorm.isDataReq;
      if (isDataReq) {
        request = dataNorm.request;
        pathname = dataNorm.normalizedPathname;
      }

      // ── Image optimization via Cloudflare Images binding ──────────
      // Checked after basePath stripping so /<basePath>/_next/image works.
      if (isImageOptimizationPath(pathname)) {
        const allowedWidths = [
          ...(vinextConfig?.images?.deviceSizes ?? DEFAULT_DEVICE_SIZES),
          ...(vinextConfig?.images?.imageSizes ?? DEFAULT_IMAGE_SIZES),
        ];
        return handleImageOptimization(request, {
          fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.${imagesBinding}.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
            return result.response();
          },
        }, allowedWidths, imageConfig);
      }

      // Delegate the canonical 9-step Next.js pipeline to the shared owner.
      // The worker adapter is responsible for: open-redirect guard, _next/static
      // 404 short-circuit, header filtering, basePath stripping, and image
      // optimization. runPagesRequest receives a clean, basePath-stripped request.
      const deps: PagesPipelineDeps = {
        basePath,
        trailingSlash,
        i18nConfig,
        configRedirects,
        configRewrites,
        configHeaders,
        hadBasePath,
        isDataReq,
        isDataRequest: isDataReq,
        ctx,
        matchPageRoute: typeof matchPageRoute === "function" ? matchPageRoute : null,
        // Pass the original (pre-basePath-stripping) URL to middleware so that
        // request.nextUrl.basePath reflects whether the URL actually had the
        // basePath prefix. Matches Next.js behavior and the prod-server.ts
        // equivalent (shared via wrapMiddlewareWithBasePath).
        runMiddleware:
          typeof runMiddleware === "function"
            ? wrapMiddlewareWithBasePath(runMiddleware, basePath, hadBasePath)
            : null,
        renderPage: typeof renderPage === "function"
          ? (req, resolvedUrl, options, stagedHeaders) =>
              renderPage(req, resolvedUrl, null, ctx, stagedHeaders, options)
          : null,
        handleApi: typeof handleApiRoute === "function"
          ? (req, apiUrl) => handleApiRoute(req, apiUrl, ctx)
          : null,
        serveFilesystemRoute: async (requestPathname, _stagedHeaders, phase) => {
          return fetchWorkerFilesystemRoute(
            request,
            requestPathname,
            phase,
            (assetRequest) => env.ASSETS.fetch(assetRequest),
          );
        },
      };

      const result = await runPagesRequest(request, deps);
      if (result.type === "response") {
        return finalizeMissingStaticAssetResponse(result.response, missingBuildAsset);
      }
      // Should not reach here for prod/worker (all callbacks supplied).
      return missingBuildAsset
        ? notFoundStaticAssetResponse()
        : new Response("This page could not be found", { status: 404 });

    } catch (error) {
      console.error("[vinext] Worker error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};

`;
  if (imageOptimization === "cloudflare-images") return source;
  return source
    .replace(
      'import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES, isImageOptimizationPath } from "vinext/server/image-optimization";\nimport type { ImageConfig } from "vinext/server/image-optimization";\n',
      "",
    )
    .replace(/\n  IMAGES: \{[\s\S]*?\n  \};\n/, "\n")
    .replace(/\nconst imageConfig:[\s\S]*?\n} : undefined;\n/, "\n")
    .replace(
      /\n      \/\/ ── Image optimization via Cloudflare Images binding ──────────[\s\S]*?(?=\n      \/\/ Delegate)/,
      "\n",
    );
}

function cacheImports(options: CloudflareInitOptions): string[] {
  const imports: string[] = [];
  if (options.dataCache === "kv") {
    imports.push('import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";');
  }
  if (options.cdnCache === "workers") {
    imports.push('import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";');
  } else if (options.cdnCache === "kv") {
    imports.push('import { kvCdnAdapter } from "@vinext/cloudflare/cache/kv-cdn-adapter";');
  } else {
    imports.push('import { noCdnCacheAdapter } from "@vinext/cloudflare/cache/no-cdn-adapter";');
  }
  return imports;
}

function vinextExpression(options: CloudflareInitOptions, binding = "vinext"): string {
  const entries: string[] = [];
  if (options.dataCache === "kv") entries.push("      data: kvDataAdapter(),");
  if (options.cdnCache === "workers") entries.push("      cdn: cdnAdapter(),");
  else if (options.cdnCache === "kv") entries.push("      cdn: kvCdnAdapter(),");
  else entries.push("      cdn: noCdnCacheAdapter(),");
  const optionLines: string[] = [];
  if (entries.length > 0) {
    optionLines.push(`    cache: {\n${entries.join("\n")}\n    },`);
  }
  if (options.imageOptimization === "none") {
    optionLines.push("    imageOptimization: false,");
  }
  return optionLines.length === 0
    ? `${binding}()`
    : `${binding}({\n${optionLines.join("\n")}\n  })`;
}

/** Generate vite.config.ts for App Router */
export function generateAppRouterViteConfig(
  info?: CloudflareProjectInfo,
  options: CloudflareInitOptions = DEFAULT_CLOUDFLARE_INIT_OPTIONS,
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

  const plugins: string[] = [];

  if (info?.hasMDX) {
    plugins.push(`    // vinext auto-injects @mdx-js/rollup with plugins from next.config`);
  }
  plugins.push(`    ${vinextExpression(options).replace(/\n/g, "\n    ")},`);

  plugins.push(`    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),`);

  // Build resolve.alias for native module stubs (tsconfig paths are handled
  // by the vinext plugin's Vite 8 native support / Vite 7 fallback).
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

  // Build resolve.alias for native module stubs (tsconfig paths are handled
  // by the vinext plugin's Vite 8 native support / Vite 7 fallback).
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
    ${vinextExpression(options).replace(/\n/g, "\n    ")},
    cloudflare(),
  ],${resolveBlock}
});
`;
}

type AstNode = ESTree.Node & { start: number; end: number };
type AstObject = ESTree.ObjectExpression & AstNode;
type AstProperty = Extract<AstObject["properties"][number], { type: "Property" }>;

function parseViteConfig(filePath: string, code: string): ESTree.Program {
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

function unwrapObject(expression: ESTree.Expression): AstObject | undefined {
  if (expression.type === "ObjectExpression") return expression as AstObject;
  if (expression.type === "ParenthesizedExpression") return unwrapObject(expression.expression);
  return undefined;
}

function findVariableObject(program: ESTree.Program, name: string): AstObject | undefined {
  for (const statement of program.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (
        declaration.id.type !== "Identifier" ||
        declaration.id.name !== name ||
        !declaration.init
      ) {
        continue;
      }
      return unwrapObject(declaration.init);
    }
  }
  return undefined;
}

function findConfigObject(program: ESTree.Program): AstObject | undefined {
  const defaultExport = program.body.find(
    (statement): statement is ESTree.ExportDefaultDeclaration =>
      statement.type === "ExportDefaultDeclaration",
  );
  if (!defaultExport) {
    for (const statement of program.body) {
      if (statement.type !== "ExpressionStatement") continue;
      const expression = statement.expression;
      if (
        expression.type !== "AssignmentExpression" ||
        expression.left.type !== "MemberExpression" ||
        expression.left.object.type !== "Identifier" ||
        expression.left.object.name !== "module" ||
        expression.left.property.type !== "Identifier" ||
        expression.left.property.name !== "exports"
      ) {
        continue;
      }
      const direct = unwrapObject(expression.right);
      if (direct) return direct;
      if (expression.right.type === "CallExpression" && expression.right.arguments.length > 0) {
        const firstArgument = expression.right.arguments[0];
        if (firstArgument.type !== "SpreadElement") return unwrapObject(firstArgument);
      }
    }
    return undefined;
  }
  if (defaultExport.declaration.type === "FunctionDeclaration") return undefined;

  const declaration = defaultExport.declaration;
  if (declaration.type === "ClassDeclaration" || declaration.type === "TSInterfaceDeclaration") {
    return undefined;
  }
  const direct = unwrapObject(declaration);
  if (direct) return direct;
  if (declaration.type === "Identifier") return findVariableObject(program, declaration.name);
  if (declaration.type !== "CallExpression" || declaration.arguments.length === 0) return undefined;

  const firstArgument = declaration.arguments[0];
  if (firstArgument.type === "SpreadElement") return undefined;
  const argumentObject = unwrapObject(firstArgument);
  if (argumentObject) return argumentObject;
  if (
    firstArgument.type !== "ArrowFunctionExpression" &&
    firstArgument.type !== "FunctionExpression"
  ) {
    return undefined;
  }

  if (!firstArgument.body) return undefined;
  if (firstArgument.body.type !== "BlockStatement") return unwrapObject(firstArgument.body);
  const returnStatement = firstArgument.body.body.find(
    (statement): statement is ESTree.ReturnStatement => statement.type === "ReturnStatement",
  );
  return returnStatement?.argument ? unwrapObject(returnStatement.argument) : undefined;
}

function importInsertionOffset(program: ESTree.Program): number {
  let offset = 0;
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
): string | undefined {
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== source) continue;
    for (const specifier of statement.specifiers) {
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.imported.type === "Identifier" &&
        specifier.imported.name === imported
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
): string {
  const existing = findImportedBinding(program, source, imported);
  if (existing) return existing;

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
): string {
  const declaration = program.body.find(
    (statement): statement is ESTree.ImportDeclaration =>
      statement.type === "ImportDeclaration" && statement.source.value === source,
  );
  const existing = declaration?.specifiers.find(
    (specifier): specifier is ESTree.ImportDefaultSpecifier =>
      specifier.type === "ImportDefaultSpecifier",
  );
  if (existing) return existing.local.name;

  const offset = importInsertionOffset(program);
  const sourceText = `import ${binding} from ${JSON.stringify(source)};`;
  output.appendLeft(offset, offset === 0 ? `${sourceText}\n` : `\n${sourceText}`);
  return binding;
}

function findRequiredBinding(
  program: ESTree.Program,
  source: string,
  imported: string,
): string | undefined {
  for (const statement of program.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (
        !declaration.init ||
        declaration.init.type !== "CallExpression" ||
        declaration.init.callee.type !== "Identifier" ||
        declaration.init.callee.name !== "require" ||
        declaration.init.arguments[0]?.type !== "Literal" ||
        declaration.init.arguments[0].value !== source
      ) {
        continue;
      }
      if (imported === "default" && declaration.id.type === "Identifier") {
        return declaration.id.name;
      }
      if (declaration.id.type !== "ObjectPattern") continue;
      for (const property of declaration.id.properties) {
        if (
          property.type === "Property" &&
          property.key.type === "Identifier" &&
          property.key.name === imported &&
          property.value.type === "Identifier"
        ) {
          return property.value.name;
        }
      }
    }
  }
  return undefined;
}

function requireInsertionOffset(program: ESTree.Program): number {
  let offset = 0;
  for (const statement of program.body) {
    if (statement.type !== "VariableDeclaration") break;
    offset = (statement as AstNode).end;
  }
  return offset;
}

function ensureNamedRequire(
  program: ESTree.Program,
  output: MagicString,
  source: string,
  imported: string,
  binding: string,
): string {
  const existing = findRequiredBinding(program, source, imported);
  if (existing) return existing;
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
): string {
  const existing = findRequiredBinding(program, source, "default");
  if (existing) return existing;
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
  const hasTrailingComma = /,\s*$/.test(code.slice(object.start + 1, offset));
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

function cloudflarePluginExpression(isAppRouter: boolean, binding: string): string {
  return isAppRouter
    ? `${binding}({\n  viteEnvironment: {\n    name: "rsc",\n    childEnvironments: ["ssr"],\n  },\n})`
    : `${binding}()`;
}

function findPluginCall(
  config: AstObject,
  binding: string,
): (ESTree.CallExpression & AstNode) | undefined {
  const plugins = findProperty(config, "plugins");
  if (!plugins || plugins.value.type !== "ArrayExpression") return undefined;
  return plugins.value.elements.find(
    (element): element is ESTree.CallExpression & AstNode =>
      element?.type === "CallExpression" &&
      element.callee.type === "Identifier" &&
      element.callee.name === binding,
  );
}

function hasVinextCacheSlot(
  call: (ESTree.CallExpression & AstNode) | undefined,
  name: "data" | "cdn",
): boolean {
  const firstArgument = call?.arguments[0];
  if (
    !firstArgument ||
    firstArgument.type === "SpreadElement" ||
    firstArgument.type !== "ObjectExpression"
  ) {
    return false;
  }
  const cache = findProperty(firstArgument as AstObject, "cache");
  return (
    cache?.value.type === "ObjectExpression" &&
    Boolean(findProperty(cache.value as AstObject, name))
  );
}

function ensureVinextCache(
  output: MagicString,
  config: AstObject,
  vinextBinding: string,
  additions: Array<{ name: "data" | "cdn"; expression: string }>,
  code: string,
): void {
  if (additions.length === 0) return;
  const call = findPluginCall(config, vinextBinding);
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

function ensureVinextImageOptimization(
  output: MagicString,
  config: AstObject,
  vinextBinding: string,
  imageOptimization: InitImageOptimization,
  code: string,
): void {
  if (imageOptimization !== "none") return;
  const call = findPluginCall(config, vinextBinding);
  if (!call) return;
  if (call.arguments.length === 0) {
    output.appendLeft(call.end - 1, "{ imageOptimization: false }");
    return;
  }
  const firstArgument = call.arguments[0];
  if (firstArgument.type === "SpreadElement" || firstArgument.type !== "ObjectExpression") {
    throw new Error(
      "The vinext() plugin options must be a static object for vinext init to configure image optimization.",
    );
  }
  const optionsObject = firstArgument as AstObject;
  const property = findProperty(optionsObject, "imageOptimization");
  if (!property) {
    insertObjectProperty(output, optionsObject, "    imageOptimization: false,", code);
  } else {
    output.overwrite((property.value as AstNode).start, (property.value as AstNode).end, "false");
  }
}

function indentBlock(source: string, indent: string): string {
  return source
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function ensurePlugins(
  output: MagicString,
  config: AstObject,
  additions: Array<{ expression: string; binding: string }>,
  code: string,
): void {
  const plugins = findProperty(config, "plugins");
  if (!plugins) {
    const expressions = additions.map(({ expression }) => indentBlock(expression, "    "));
    insertObjectProperty(output, config, `  plugins: [\n${expressions.join(",\n")},\n  ],`, code);
    return;
  }
  if (plugins.value.type !== "ArrayExpression") {
    throw new Error(
      "The Vite config's plugins option must be an array for vinext init to update it.",
    );
  }
  const array = plugins.value as ESTree.ArrayExpression & AstNode;
  const propertyIndent =
    code
      .slice(0, (plugins as AstNode).start)
      .split("\n")
      .at(-1)
      ?.match(/^\s*/)?.[0] ?? "";
  const elementIndent = `${propertyIndent}  `;
  const missingExpressions: string[] = [];
  for (const addition of additions) {
    const alreadyConfigured = array.elements.some(
      (element) =>
        element?.type === "CallExpression" &&
        element.callee.type === "Identifier" &&
        element.callee.name === addition.binding,
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
  output.appendLeft(
    closingOffset,
    `${prefix}\n${missingExpressions
      .map((expression) => indentBlock(expression, elementIndent))
      .join(",\n")},\n${propertyIndent}`,
  );
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

export function updateViteConfigForCloudflare(
  filePath: string,
  code: string,
  options: {
    isAppRouter: boolean;
    nativeModulesToStub: string[];
    cache?: CloudflareInitOptions;
  },
): string {
  const program = parseViteConfig(filePath, code);
  const cacheOptions = options.cache ?? {
    dataCache: "none",
    cdnCache: "none",
    imageOptimization: "cloudflare-images",
  };
  const config = findConfigObject(program);
  if (!config) {
    throw new Error(
      `Could not find a static Vite config object in ${path.basename(filePath)}. Use an object export or defineConfig({...}) so vinext init can update it.`,
    );
  }

  const output = new MagicString(code);
  const commonJs = usesCommonJsViteConfig(filePath, code);
  const bindings = collectTopLevelBindings(program);
  const existingVinextBinding = commonJs
    ? findRequiredBinding(program, "vinext", "default")
    : program.body
        .filter(
          (statement): statement is ESTree.ImportDeclaration =>
            statement.type === "ImportDeclaration",
        )
        .find((statement) => statement.source.value === "vinext")
        ?.specifiers.find(
          (specifier): specifier is ESTree.ImportDefaultSpecifier =>
            specifier.type === "ImportDefaultSpecifier",
        )?.local.name;
  const vinextLocal = existingVinextBinding ?? allocateBinding(bindings, "vinext");
  const vinextBinding = commonJs
    ? ensureDefaultRequire(program, output, "vinext", vinextLocal)
    : ensureDefaultImport(program, output, "vinext", vinextLocal);
  const existingVinextCall = findPluginCall(config, vinextBinding);
  const configureCaches = options.cache !== undefined;
  const cacheAdditions: Array<{ name: "data" | "cdn"; expression: string }> = [];
  if (cacheOptions.dataCache === "kv" && !hasVinextCacheSlot(existingVinextCall, "data")) {
    const existing = commonJs
      ? findRequiredBinding(program, "@vinext/cloudflare/cache/kv-data-adapter", "kvDataAdapter")
      : findImportedBinding(program, "@vinext/cloudflare/cache/kv-data-adapter", "kvDataAdapter");
    const local = existing ?? allocateBinding(bindings, "kvDataAdapter");
    const binding = commonJs
      ? ensureNamedRequire(
          program,
          output,
          "@vinext/cloudflare/cache/kv-data-adapter",
          "kvDataAdapter",
          local,
        )
      : ensureNamedImport(
          program,
          output,
          "@vinext/cloudflare/cache/kv-data-adapter",
          "kvDataAdapter",
          local,
        );
    cacheAdditions.push({ name: "data", expression: `${binding}()` });
  }
  if (configureCaches && !hasVinextCacheSlot(existingVinextCall, "cdn")) {
    const imported =
      cacheOptions.cdnCache === "workers"
        ? "cdnAdapter"
        : cacheOptions.cdnCache === "kv"
          ? "kvCdnAdapter"
          : "noCdnCacheAdapter";
    const source =
      cacheOptions.cdnCache === "workers"
        ? "@vinext/cloudflare/cache/cdn-adapter"
        : cacheOptions.cdnCache === "kv"
          ? "@vinext/cloudflare/cache/kv-cdn-adapter"
          : "@vinext/cloudflare/cache/no-cdn-adapter";
    const existing = commonJs
      ? findRequiredBinding(program, source, imported)
      : findImportedBinding(program, source, imported);
    const local = existing ?? allocateBinding(bindings, imported);
    const binding = commonJs
      ? ensureNamedRequire(program, output, source, imported, local)
      : ensureNamedImport(program, output, source, imported, local);
    cacheAdditions.push({ name: "cdn", expression: `${binding}()` });
  }
  const existingCloudflareBinding = commonJs
    ? findRequiredBinding(program, "@cloudflare/vite-plugin", "cloudflare")
    : findImportedBinding(program, "@cloudflare/vite-plugin", "cloudflare");
  const cloudflareLocal = existingCloudflareBinding ?? allocateBinding(bindings, "cloudflare");
  const cloudflareBinding = commonJs
    ? ensureNamedRequire(program, output, "@cloudflare/vite-plugin", "cloudflare", cloudflareLocal)
    : ensureNamedImport(program, output, "@cloudflare/vite-plugin", "cloudflare", cloudflareLocal);
  ensurePlugins(
    output,
    config,
    [
      {
        expression: existingVinextCall
          ? `${vinextBinding}()`
          : options.cache
            ? vinextExpression(cacheOptions, vinextBinding).replace(/\n/g, "\n  ")
            : `${vinextBinding}()`,
        binding: vinextBinding,
      },
      {
        expression: cloudflarePluginExpression(options.isAppRouter, cloudflareBinding),
        binding: cloudflareBinding,
      },
    ],
    code,
  );
  if (existingVinextCall) {
    ensureVinextCache(output, config, vinextBinding, cacheAdditions, code);
    ensureVinextImageOptimization(
      output,
      config,
      vinextBinding,
      cacheOptions.imageOptimization,
      code,
    );
  }

  if (options.nativeModulesToStub.length > 0) {
    const existingPathBinding = commonJs
      ? findRequiredBinding(program, "node:path", "default")
      : program.body
          .filter(
            (statement): statement is ESTree.ImportDeclaration =>
              statement.type === "ImportDeclaration",
          )
          .find((statement) => statement.source.value === "node:path")
          ?.specifiers.find(
            (specifier): specifier is ESTree.ImportDefaultSpecifier =>
              specifier.type === "ImportDefaultSpecifier",
          )?.local.name;
    const pathLocal = existingPathBinding ?? allocateBinding(bindings, "path");
    const pathBinding = commonJs
      ? ensureDefaultRequire(program, output, "node:path", pathLocal)
      : ensureDefaultImport(program, output, "node:path", pathLocal);
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
