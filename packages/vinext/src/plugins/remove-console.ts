/**
 * Strip `console.*` calls from client bundle code.
 *
 * Mirrors Next.js's SWC `remove_console` transform:
 *   - Strips all `console.<method>()` calls regardless of context (top-level,
 *     JSX expressions, function arguments, return values, ternary branches)
 *   - Replaces removed calls with `void 0` to keep the AST valid in every
 *     position a CallExpression can appear
 *   - Respects `exclude: ["error"]` to preserve certain methods (case-insensitive)
 *   - Preserves calls when `console` is shadowed (local variable, function
 *     parameter, or destructured binding)
 *   - Preserves computed property access `console[prop]()`
 *
 * Uses Vite's `parseAst` (OXC/acorn) for parsing and `MagicString` for
 * surgical source replacement. Returns `null` when no changes are made.
 */
import { parseAst } from "vite";
import MagicString from "magic-string";

type ASTNode = ReturnType<typeof parseAst>["body"][number]["parent"];
type BindingNode = Extract<ASTNode, { type: string }>;

type RemoveConsoleConfig = boolean | { exclude: string[] };

type RemoveConsoleResult = {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
};

// Node types that introduce a new function-style scope. Hoisted to a module-
// level Set so the membership check in walk() is O(1) and doesn't allocate
// per recursive call.
const SCOPE_ENTERING_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/**
 * Walk the AST body looking for expression statements whose expression is a
 * CallExpression with a callee of `console.<identifier>`. When found, check
 * that the name is not in the excluded set and that `console` is not shadowed
 * at this scope. If all conditions pass, replace the entire statement with `;`.
 *
 * Returns `null` if no console calls are removed.
 */
export function removeConsoleCalls(
  code: string,
  config: RemoveConsoleConfig,
): RemoveConsoleResult | null {
  if (config === false) return null;

  const excluded =
    typeof config === "object"
      ? new Set(config.exclude.map((s) => s.toLowerCase()))
      : new Set<string>();

  // Fast path: if there's no bare "console" reference, skip parsing.
  // This avoids the parse cost for the vast majority of modules.
  const consoleMatch = code.match(/\bconsole\b/);
  if (!consoleMatch) return null;

  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code);
  } catch {
    // If parsing fails (shouldn't happen post-transform), bail out
    return null;
  }

  // Collect shadowing scopes: tracks whether there's a local binding named
  // "console" in the current or any parent scope. We do a simple top-down
  // walk maintaining a stack of scope frames. Each function/arrow/block
  // introduces a new frame. When we see a declaration/parameter of name
  // "console", that frame (and its descendants) are shadowed.
  type Scope = { shadowed: boolean };
  const scopeStack: Scope[] = [{ shadowed: false }];

  function currentScope(): Scope {
    return scopeStack[scopeStack.length - 1]!;
  }

  function pushScope(): void {
    // Child inherits parent shadowed status
    scopeStack.push({ shadowed: currentScope().shadowed });
  }

  function popScope(): void {
    scopeStack.pop();
  }

  const s = new MagicString(code);
  let changed = false;

  /**
   * Check if a node introduces a binding named "console" and mark scope.
   * Recurses into all binding-pattern node types (destructuring shapes,
   * defaults, rest elements).
   */
  function checkBinding(node: BindingNode | null | undefined): void {
    if (!node) return;
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check
    switch (node.type) {
      case "Identifier": {
        if (node.name === "console") {
          currentScope().shadowed = true;
        }
        break;
      }
      case "ObjectPattern": {
        for (const prop of node.properties) {
          checkBinding(prop as BindingNode);
        }
        break;
      }
      case "Property": {
        // For `{ key: value }` and `{ console }` (shorthand) — the binding name
        // is in `value`, not `key`. Recurse so AssignmentPattern defaults,
        // nested patterns, etc. are all handled.
        const propertyNode = node as unknown as { value?: BindingNode };
        if (propertyNode.value) checkBinding(propertyNode.value);
        break;
      }
      case "ArrayPattern": {
        // oxlint-disable-next-line typescript/no-explicit-any
        const elements = (node as any).elements as Array<BindingNode | null> | undefined;
        if (elements) {
          for (const el of elements) {
            checkBinding(el);
          }
        }
        break;
      }
      case "AssignmentPattern": {
        // `x = default` — the binding is `left`, the default value is `right`.
        // oxlint-disable-next-line typescript/no-explicit-any
        const left = (node as any).left as BindingNode | undefined;
        checkBinding(left);
        break;
      }
      case "RestElement": {
        // `...x` — the binding is `argument`.
        // oxlint-disable-next-line typescript/no-explicit-any
        const argument = (node as any).argument as BindingNode | undefined;
        checkBinding(argument);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Check if an identifier refers to the *global* console.
   * It's global only when:
   *   1. Its name is "console"
   *   2. No local binding of that name shadows it at this point
   */
  function isGlobalConsole(node: BindingNode): boolean {
    return node.type === "Identifier" && node.name === "console" && !currentScope().shadowed;
  }

  /**
   * Determine if a call expression is a `console.<method>()` that should be
   * removed. The callee must be a MemberExpression with:
   *   - object: Identifier "console" (global, not shadowed)
   *   - property: Identifier (NOT computed — computed access like
   *     `console[prop]()` is preserved per Next.js behavior)
   * The method name must NOT be in the excluded set.
   */
  function shouldRemove(node: BindingNode): boolean {
    if (node.type !== "CallExpression") return false;
    const callee = node.callee;
    if (callee.type !== "MemberExpression") return false;

    // Only handle dot access: console.log() — skip computed: console[prop]()
    if (callee.computed) return false;

    // The object must be the global console identifier
    if (!isGlobalConsole(callee.object)) return false;

    // Property must be an identifier (e.g., "log", "warn")
    const prop = callee.property;
    if (prop.type !== "Identifier") return false;

    const method = prop.name.toLowerCase();
    if (excluded.has(method)) return false;

    return true;
  }

  /**
   * Recursively walk a node tree, managing scope for shadow detection.
   * When a CallExpression matches `console.<method>()`, replace it with
   * `void 0`. If the call is the sole expression of an ExpressionStatement,
   * replace the entire statement with `;` for cleaner output.
   */
  function walk(node: ASTNode, parent?: ASTNode): void {
    if (!node) return;

    if (node.type === "CallExpression" && shouldRemove(node)) {
      if (parent?.type === "ExpressionStatement") {
        // Replace the whole statement so we don't leave `void 0;` litter
        s.overwrite(parent.start, parent.end, ";");
      } else {
        s.overwrite(node.start, node.end, "void 0");
      }
      changed = true;
      return; // don't recurse into children of a removed call
    }

    // `function console() {}` and `class console {}` bind `console` in the
    // *enclosing* scope (function declarations are hoisted to function/module
    // scope, class declarations are block-scoped). Check `id` against the
    // current scope BEFORE pushing the function's own scope, so the binding
    // is visible both outside and inside the function (via scope inheritance).
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      // oxlint-disable-next-line typescript/no-explicit-any
      const id = (node as any).id as BindingNode | undefined;
      checkBinding(id);
    }

    const isScopeEntering = SCOPE_ENTERING_TYPES.has(node.type);
    if (isScopeEntering) {
      pushScope();

      // Named FunctionExpressions (`const x = function console() {}`) bind
      // their name only in their *own* scope — not the enclosing one — so
      // mark after pushing.
      if (node.type === "FunctionExpression") {
        // oxlint-disable-next-line typescript/no-explicit-any
        const id = (node as any).id as BindingNode | undefined;
        checkBinding(id);
      }

      // Mark params/destructured params
      // oxlint-disable-next-line typescript/no-explicit-any
      const params = (node as any).params as ASTNode[] | undefined;
      if (params) {
        for (const param of params) {
          checkBinding(param as BindingNode);
        }
      }
    }

    // CatchClause introduces a binding for its param (`catch (e) { ... }`).
    // If the param shadows "console", the catch block must treat console as
    // local. We push a scope just for the param binding; the BlockStatement
    // body below will push its own scope on top, which inherits the shadow.
    const isCatchScope = node.type === "CatchClause";
    if (isCatchScope) {
      pushScope();
      // oxlint-disable-next-line typescript/no-explicit-any
      const param = (node as any).param as BindingNode | undefined;
      if (param) {
        checkBinding(param);
      }
    }

    // Also enter a new scope for BlockStatement / Program bodies so that
    // variable declarations are checked in the right frame.
    //
    // KNOWN LIMITATION: `var` is function-scoped, not block-scoped. A `var
    // console = ...` inside a nested block (if/for/etc.) is hoisted to the
    // enclosing function, but we treat it as block-scoped here, so console
    // references after the block exits its scope frame will be incorrectly
    // stripped. `let`/`const` are block-scoped so this only affects `var`.
    // In real-world code, shadowing `console` with `var` is exceedingly rare.
    const isBlockScope =
      node.type === "BlockStatement" || node.type === "Program" || node.type === "SwitchCase";
    if (isBlockScope && !isScopeEntering) {
      pushScope();
    }

    // Check for local variable declarations of "console"
    if (node.type === "VariableDeclaration") {
      // oxlint-disable-next-line typescript/no-explicit-any
      for (const decl of (node as any).declarations ?? []) {
        checkBinding(decl.id as BindingNode);
      }
    }

    // Recurse into child nodes, passing current node as parent
    for (const key of Object.keys(node)) {
      if (key === "parent" || key === "start" || key === "end") continue;
      // oxlint-disable-next-line typescript/no-explicit-any
      const child = (node as any)[key];
      if (child && typeof child === "object") {
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item && typeof item === "object" && "type" in item) {
              walk(item as BindingNode, node);
            }
          }
        } else if ("type" in child) {
          walk(child as BindingNode, node);
        }
      }
    }

    if (isScopeEntering || isBlockScope || isCatchScope) {
      popScope();
    }
  }

  for (const node of ast.body) {
    walk(node);
  }

  if (!changed) return null;
  // Emit the MagicString sourcemap rather than dropping it: stripped calls and
  // statements shift positions, so a null map would break client-build debugging.
  return { code: s.toString(), map: s.generateMap({ hires: "boundary" }) };
}
