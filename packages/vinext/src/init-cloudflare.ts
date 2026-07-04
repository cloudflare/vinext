import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import MagicString from "magic-string";
import type { ESTree } from "vite";
import type { CloudflareInitOptions } from "./init-platform.js";
import { detectProject } from "./utils/project.js";

const require = createRequire(import.meta.url);

export type CloudflareProjectInfo = {
  root: string;
  projectName: string;
  isAppRouter: boolean;
  hasISR: boolean;
  hasMDX: boolean;
  nativeModulesToStub: string[];
};

const DEFAULT_CLOUDFLARE_INIT_OPTIONS: CloudflareInitOptions = {
  dataCache: "kv",
  cdnCache: "workers-cache",
  imageOptimization: "cloudflare-images",
};

export type CloudflarePlatformSetupContext = {
  root: string;
  isAppRouter: boolean;
  existingViteConfigPath?: string;
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
  const updatedWranglerCode = wranglerCode
    ? updateWranglerConfigForCloudflare(wranglerCode, cloudflare)
    : undefined;
  const imagesBinding = updatedWranglerCode
    ? getWranglerImagesBinding(updatedWranglerCode)
    : "IMAGES";

  if (context.existingViteConfigPath) {
    updateViteConfigForCloudflare(
      context.existingViteConfigPath,
      fs.readFileSync(context.existingViteConfigPath, "utf-8"),
      {
        isAppRouter: context.isAppRouter,
        nativeModulesToStub: projectInfo.nativeModulesToStub,
        cache: cloudflare,
        imagesBinding,
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
  const imagesBinding = wranglerCode ? getWranglerImagesBinding(wranglerCode) : "IMAGES";

  let generatedViteConfig = false;
  let skippedViteConfig = false;
  if (context.existingViteConfigPath) {
    const currentConfig = fs.readFileSync(context.existingViteConfigPath, "utf-8");
    const updatedConfig = updateViteConfigForCloudflare(
      context.existingViteConfigPath,
      currentConfig,
      {
        isAppRouter: context.isAppRouter,
        nativeModulesToStub: projectInfo.nativeModulesToStub,
        cache: cloudflare,
        imagesBinding,
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
      ? generateAppRouterViteConfig(projectInfo, cloudflare, imagesBinding, context.prerender)
      : generatePagesRouterViteConfig(projectInfo, cloudflare, imagesBinding, context.prerender);
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
  } else if (wranglerCode) {
    const updatedConfig = updateWranglerConfigForCloudflare(wranglerCode, cloudflare);
    if (updatedConfig !== wranglerCode) {
      fs.writeFileSync(wranglerPath, updatedConfig, "utf-8");
      generatedPlatformFiles.push(path.basename(wranglerPath));
    }
  }

  const finalWranglerPath = wranglerPath ?? path.join(context.root, "wrangler.jsonc");
  const finalWranglerFileName = path.basename(finalWranglerPath);
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

  return {
    generatedViteConfig,
    skippedViteConfig,
    generatedPlatformFiles,
    nextSteps: needsKvNamespaceId
      ? [
          "Cloudflare setup is incomplete until you finish KV configuration:",
          "1. Create the KV namespace:",
          "   npx wrangler kv namespace create VINEXT_KV_CACHE",
          `2. Copy the returned namespace ID into the VINEXT_KV_CACHE entry in ${finalWranglerFileName}:`,
          '   Set its "id" value, replacing "<your-kv-namespace-id>" if present.',
        ]
      : [],
  };
}

// Cloudflare deployment scaffolding belongs to `vinext init`.
export function generateWranglerConfig(
  info: CloudflareProjectInfo,
  options: CloudflareInitOptions = DEFAULT_CLOUDFLARE_INIT_OPTIONS,
  today = new Date().toISOString().split("T")[0],
): string {
  const customWorkerEntry = fs.existsSync(path.join(info.root, "worker", "index.ts"))
    ? "./worker/index.ts"
    : fs.existsSync(path.join(info.root, "worker", "index.js"))
      ? "./worker/index.js"
      : undefined;
  const workerEntry = customWorkerEntry ?? "vinext/server/fetch-handler";

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

  if (options.cdnCache === "workers-cache") config.cache = { enabled: true };

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
  const structuralBefore = stripJsonComments(before);
  const needsComma = !/,\s*$/.test(structuralBefore) && !/{\s*$/.test(structuralBefore);
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

function cacheImports(options: CloudflareInitOptions): string[] {
  const imports: string[] = [];
  if (options.dataCache === "kv") {
    imports.push('import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";');
  }
  if (options.cdnCache === "workers-cache") {
    imports.push('import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";');
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
): string {
  const cacheEntries: string[] = [];
  if (options.dataCache === "kv") {
    cacheEntries.push("data: kvDataAdapter()");
  }
  if (options.cdnCache === "workers-cache") cacheEntries.push("cdn: cdnAdapter()");
  const optionEntries: string[] = [];
  if (cacheEntries.length > 0) {
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
  plugins.push(
    `    ${vinextExpression(options, "vinext", "imagesOptimizer", imagesBinding, prerender).replace(/\n/g, "\n    ")},`,
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
    ${vinextExpression(options, "vinext", "imagesOptimizer", imagesBinding, prerender).replace(/\n/g, "\n    ")},
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

function ensureVinextImageOptimizer(
  output: MagicString,
  config: AstObject,
  vinextBinding: string,
  expression: string | undefined,
  code: string,
): void {
  if (!expression) return;
  const call = findPluginCall(config, vinextBinding);
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
): void {
  if (!prerender) return;
  const call = findPluginCall(config, vinextBinding);
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
  const inlineArray = !code.slice(array.start, array.end).includes("\n");
  if (inlineArray && hasExistingElements) {
    output.appendLeft(array.start + 1, `\n${elementIndent}`);
    let previousElement: ESTree.ArrayExpressionElement | null = null;
    for (const element of array.elements) {
      if (!element) continue;
      if (previousElement) {
        const gap = code.slice((previousElement as AstNode).end, (element as AstNode).start);
        const commaIndex = gap.indexOf(",");
        if (commaIndex >= 0) {
          const trivia = gap.slice(commaIndex + 1).trim();
          output.overwrite(
            (previousElement as AstNode).end,
            (element as AstNode).start,
            trivia ? `,\n${elementIndent}${trivia}\n${elementIndent}` : `,\n${elementIndent}`,
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
    imagesBinding?: string;
    prerender?: boolean;
  },
): string {
  const program = parseViteConfig(filePath, code);
  const cacheOptions = options.cache ?? {
    dataCache: "none",
    cdnCache: "workers-cache",
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
  const existingImageOptimizer = getVinextImageOptimizer(existingVinextCall);
  const needsPrerender = Boolean(options.prerender && !hasVinextPrerender(existingVinextCall));
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
  if (
    configureCaches &&
    cacheOptions.cdnCache === "workers-cache" &&
    !hasVinextCacheSlot(existingVinextCall, "cdn")
  ) {
    const imported = "cdnAdapter";
    const source = "@vinext/cloudflare/cache/cdn-adapter";
    const existing = commonJs
      ? findRequiredBinding(program, source, imported)
      : findImportedBinding(program, source, imported);
    const local = existing ?? allocateBinding(bindings, imported);
    const binding = commonJs
      ? ensureNamedRequire(program, output, source, imported, local)
      : ensureNamedImport(program, output, source, imported, local);
    cacheAdditions.push({ name: "cdn", expression: `${binding}()` });
  }
  let imageOptimizerExpression: string | undefined;
  if (cacheOptions.imageOptimization === "cloudflare-images") {
    const source = "@vinext/cloudflare/images/images-optimizer";
    const imported = "imagesOptimizer";
    const existing = commonJs
      ? findRequiredBinding(program, source, imported)
      : findImportedBinding(program, source, imported);
    if (
      !isUsableImageOptimizer(existingImageOptimizer) ||
      isImagesOptimizerCall(existingImageOptimizer, existing)
    ) {
      const local = existing ?? allocateBinding(bindings, imported);
      const imageBinding = commonJs
        ? ensureNamedRequire(program, output, source, imported, local)
        : ensureNamedImport(program, output, source, imported, local);
      const bindingOption =
        options.imagesBinding && options.imagesBinding !== "IMAGES"
          ? `{ binding: ${JSON.stringify(options.imagesBinding)} }`
          : "";
      imageOptimizerExpression = `${imageBinding}(${bindingOption})`;
    }
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
          : options.cache || options.prerender
            ? vinextExpression(
                cacheOptions,
                vinextBinding,
                imageOptimizerExpression?.slice(0, imageOptimizerExpression.indexOf("(")) ||
                  "imagesOptimizer",
                options.imagesBinding,
                options.prerender,
              )
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
    if (
      existingVinextCall.arguments.length === 0 &&
      (cacheAdditions.length > 0 || imageOptimizerExpression || needsPrerender)
    ) {
      const properties: string[] = [];
      if (cacheAdditions.length > 0) {
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
      const plugins = findProperty(config, "plugins");
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
      ensureVinextCache(output, config, vinextBinding, cacheAdditions, code);
      ensureVinextImageOptimizer(output, config, vinextBinding, imageOptimizerExpression, code);
      ensureVinextPrerender(output, config, vinextBinding, options.prerender, code);
    }
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
