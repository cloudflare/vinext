import fs from "node:fs";
import MagicString from "magic-string";
import path, { toSlash } from "pathslash";
import { parseAst, type Plugin } from "vite";

export type IsolatedRouteRuntime = "edge";

const ROUTE_RUNTIME_QUERY_KEY = "vinext-route-runtime";
const SCRIPT_MODULE_RE = /\.[cm]?[jt]sx?$/i;
const VINEXT_RUNTIME_ROOT = toSlash(path.resolve(import.meta.dirname, ".."));

function splitModuleId(id: string): {
  pathname: string;
  query: string;
  hash: string;
} {
  const hashIndex = id.indexOf("#");
  const hash = hashIndex === -1 ? "" : id.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? id : id.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  return {
    pathname: queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex),
    query: queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1),
    hash,
  };
}

function isRouteRuntimeQueryPart(part: string): boolean {
  return part === ROUTE_RUNTIME_QUERY_KEY || part.startsWith(`${ROUTE_RUNTIME_QUERY_KEY}=`);
}

function routeRuntimeQueryValue(query: string): string | null {
  for (const part of query.split("&")) {
    if (!isRouteRuntimeQueryPart(part)) continue;
    const equalsIndex = part.indexOf("=");
    return equalsIndex === -1 ? "" : part.slice(equalsIndex + 1);
  }
  return null;
}

function withoutRouteRuntimeQuery(query: string): string {
  return query
    .split("&")
    .filter((part) => !isRouteRuntimeQueryPart(part))
    .join("&");
}

export function getIsolatedRouteRuntime(id: string): IsolatedRouteRuntime | null {
  return routeRuntimeQueryValue(splitModuleId(id).query) === "edge" ? "edge" : null;
}

export function withIsolatedRouteRuntime(id: string, runtime: IsolatedRouteRuntime | null): string {
  if (!runtime) return id;
  const { pathname, query, hash } = splitModuleId(id);
  const existingQuery = withoutRouteRuntimeQuery(query);
  const runtimeQuery = `${ROUTE_RUNTIME_QUERY_KEY}=${runtime}`;
  return `${pathname}?${existingQuery ? `${existingQuery}&` : ""}${runtimeQuery}${hash}`;
}

function withoutIsolatedRouteRuntime(id: string): string {
  const { pathname, query, hash } = splitModuleId(id);
  const remainingQuery = withoutRouteRuntimeQuery(query);
  const search = remainingQuery ? `?${remainingQuery}` : "";
  return `${pathname}${search}${hash}`;
}

type AstNode = NonNullable<ReturnType<typeof parseAst>["body"][number]["parent"]>;

function isIdentifier(node: unknown, name: string): boolean {
  return (
    typeof node === "object" &&
    node !== null &&
    Reflect.get(node, "type") === "Identifier" &&
    Reflect.get(node, "name") === name
  );
}

function isNextRuntimeExpression(node: AstNode): boolean {
  if (node.type !== "MemberExpression") return false;
  const member = node as AstNode & {
    computed?: boolean;
    object?: AstNode;
    property?: AstNode;
  };
  if (member.computed || !isIdentifier(member.property, "NEXT_RUNTIME")) return false;

  const envMember = member.object as
    | (AstNode & { computed?: boolean; object?: AstNode; property?: AstNode })
    | undefined;
  return (
    envMember?.type === "MemberExpression" &&
    !envMember.computed &&
    isIdentifier(envMember.object, "process") &&
    isIdentifier(envMember.property, "env")
  );
}

function parserLanguageForId(id: string): "ts" | "tsx" {
  const pathname = splitModuleId(id).pathname.toLowerCase();
  return pathname.endsWith(".ts") || pathname.endsWith(".mts") || pathname.endsWith(".cts")
    ? "ts"
    : "tsx";
}

function isClientBoundary(id: string): boolean {
  const pathname = splitModuleId(id).pathname;
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(fs.readFileSync(pathname, "utf8"), { lang: parserLanguageForId(pathname) });
  } catch {
    return false;
  }

  for (const statement of ast.body) {
    if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string") {
      return false;
    }
    if (statement.directive === "use client") return true;
  }
  return false;
}

export function replaceNextRuntimeForIsolatedRoute(
  code: string,
  id: string,
  runtime: IsolatedRouteRuntime,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code, { lang: parserLanguageForId(id) });
  } catch {
    return null;
  }

  const output = new MagicString(code);
  let changed = false;

  function walk(node: AstNode | AstNode[] | null | undefined): void {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== "object") return;

    if (
      isNextRuntimeExpression(node) &&
      typeof node.start === "number" &&
      typeof node.end === "number"
    ) {
      output.overwrite(node.start, node.end, JSON.stringify(runtime));
      changed = true;
      return;
    }

    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "parent") {
        continue;
      }
      const value = Reflect.get(node, key) as unknown;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === "object" && "type" in child) {
            walk(child as AstNode);
          }
        }
      } else if (value && typeof value === "object" && "type" in value) {
        walk(value as AstNode);
      }
    }
  }

  walk(ast.body);
  return changed
    ? {
        code: output.toString(),
        map: output.generateMap({ hires: "boundary" }),
      }
    : null;
}

function isProjectScript(root: string, id: string): boolean {
  const pathname = toSlash(splitModuleId(id).pathname);
  if (!path.isAbsolute(pathname) || pathname.includes("/node_modules/")) return false;
  if (!SCRIPT_MODULE_RE.test(pathname)) return false;
  const relativeToVinext = path.relative(VINEXT_RUNTIME_ROOT, pathname);
  if (
    relativeToVinext === "" ||
    (!relativeToVinext.startsWith("..") && !path.isAbsolute(relativeToVinext))
  ) {
    return false;
  }
  const relative = path.relative(root, pathname);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Give edge App routes their own user-module graph so Next.js' compile-time
 * `process.env.NEXT_RUNTIME` value can differ from the default nodejs graph.
 *
 * Next.js emits one server bundle per route. Vinext emits one RSC environment,
 * so an edge route that shares a helper with a nodejs route would otherwise
 * reuse the nodejs-evaluated helper. The query is propagated only through
 * project-local script dependencies; framework and node_modules graphs remain
 * shared.
 */
export function createRouteRuntimeIsolationPlugin(): Plugin {
  return {
    name: "vinext:route-runtime-isolation",
    enforce: "pre",
    async resolveId(source, importer) {
      if (this.environment?.name !== "rsc" || !importer) return null;
      const runtime = getIsolatedRouteRuntime(importer);
      if (!runtime) return null;

      const resolved = await this.resolve(source, withoutIsolatedRouteRuntime(importer), {
        skipSelf: true,
      });
      if (!resolved) return null;

      const root = toSlash(this.environment.config.root);
      if (!isProjectScript(root, resolved.id) || isClientBoundary(resolved.id)) return resolved;
      return { ...resolved, id: withIsolatedRouteRuntime(resolved.id, runtime) };
    },
    transform: {
      filter: {
        id: new RegExp(`[?&]${ROUTE_RUNTIME_QUERY_KEY}=edge(?:[&#]|$)`),
        code: "process.env.NEXT_RUNTIME",
      },
      handler(code, id) {
        if (this.environment?.name !== "rsc") return null;
        const runtime = getIsolatedRouteRuntime(id);
        return runtime ? replaceNextRuntimeForIsolatedRoute(code, id, runtime) : null;
      },
    },
  };
}
