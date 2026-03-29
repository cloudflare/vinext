import type { Plugin } from "vite";
import { parseAst } from "vite";
import MagicString from "magic-string";

/**
 * Fix 'use server' closure variable collision with local declarations.
 *
 * @vitejs/plugin-rsc uses `periscopic` to find closure variables for
 * 'use server' inline functions. Due to how periscopic handles block scopes,
 * `const X = ...` declared inside a 'use server' function body is tracked in
 * the BlockStatement scope (not the FunctionDeclaration scope). When periscopic
 * searches for the owner of a reference `X`, it finds the block scope — which
 * is neither the function scope nor the module scope — so it incorrectly
 * classifies `X` as a closure variable from the outer scope.
 *
 * The result: plugin-rsc injects `const [X] = await decryptActionBoundArgs(...)`
 * at the top of the hoisted function, colliding with the existing `const X = ...`
 * declaration in the body. This causes a SyntaxError.
 *
 * Fix: before plugin-rsc sees the file, detect any 'use server' function whose
 * local `const/let/var` declarations shadow an outer-scope variable, and rename
 * the inner declarations (+ usages within that function) to `__local_X`. This
 * eliminates the collision without changing semantics.
 *
 * This is a general fix that works for any library — not just @payloadcms/next.
 */
export const fixUseServerClosureCollisionPlugin: Plugin = {
  name: "vinext:fix-use-server-closure-collision",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    // Quick bail-out: only files that contain 'use server' inline
    if (!code.includes("use server")) return null;
    // Only JS/TS files
    if (!/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(id.split("?")[0])) return null;

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    let ast: any;
    try {
      ast = parseAst(code);
    } catch {
      return null;
    }

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    function collectPatternNames(pattern: any, names: Set<string>) {
      if (!pattern) return;
      if (pattern.type === "Identifier") {
        names.add(pattern.name);
      } else if (pattern.type === "ObjectPattern") {
        for (const prop of pattern.properties) {
          collectPatternNames(prop.value ?? prop.argument, names);
        }
      } else if (pattern.type === "ArrayPattern") {
        for (const elem of pattern.elements) {
          collectPatternNames(elem, names);
        }
      } else if (pattern.type === "RestElement" || pattern.type === "AssignmentPattern") {
        collectPatternNames(pattern.left ?? pattern.argument, names);
      }
    }

    // Check if a block body has 'use server' as its leading directive prologue.
    // Only the first contiguous run of string-literal expression statements
    // counts — a "use server" string mid-function is not a directive.
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    function hasUseServerDirective(body: any[]): boolean {
      for (const stmt of body) {
        if (
          stmt.type === "ExpressionStatement" &&
          stmt.expression?.type === "Literal" &&
          typeof stmt.expression.value === "string"
        ) {
          if (stmt.expression.value === "use server") return true;
          // Any other string literal in the prologue — keep scanning
          continue;
        }
        // First non-string-literal statement ends the prologue
        break;
      }
      return false;
    }

    // Find all 'use server' inline functions and check for collisions.
    //
    // `ancestorNames` accumulates the names that are in scope in all ancestor
    // function/program bodies as we descend — this is the correct set to
    // compare against, not a whole-AST walk (which would pick up siblings).
    const s = new MagicString(code);
    // Track source ranges already rewritten so renamingWalk never calls
    // s.update() twice on the same span (MagicString throws if it does).
    const renamedRanges = new Set<string>();
    let changed = false;

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    function visitNode(node: any, ancestorNames: Set<string>) {
      if (!node || typeof node !== "object") return;

      const isFn =
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression";

      if (!isFn) {
        // Non-function nodes (Program, BlockStatement, IfStatement, CatchClause,
        // etc.) don't introduce a new function scope, but they may contain
        // variable declarations and catch bindings that are visible to nested
        // functions as ancestor names.  Accumulate those into a new set before
        // recursing so we don't mutate the caller's set.
        const namesForChildren = new Set(ancestorNames);

        // CatchClause: `catch (e)` — `e` is in scope for the catch body
        if (node.type === "CatchClause" && node.param) {
          collectPatternNames(node.param, namesForChildren);
        }

        // Collect names visible at function scope from this node:
        //   - FunctionDeclaration names (hoisted to enclosing scope)
        //   - ClassDeclaration names (block-scoped like let, but treated as
        //     function-scoped for our purposes since periscopic sees them)
        //   - var declarations (hoisted to function scope, found anywhere)
        // We do NOT collect let/const from nested blocks here — those are
        // block-scoped and not visible to sibling/outer function declarations.
        collectFunctionScopedNames(node, namesForChildren);
        // Also collect let/const/var/class/import declared as immediate children
        // of this node (e.g. top-level Program statements, or the direct body of
        // a BlockStatement) — those ARE in scope for everything in the same block.
        const immediateStmts: any[] =
          node.type === "Program" ? node.body : node.type === "BlockStatement" ? node.body : [];
        for (const stmt of immediateStmts) {
          if (stmt?.type === "VariableDeclaration") {
            for (const decl of stmt.declarations) collectPatternNames(decl.id, namesForChildren);
          } else if (stmt?.type === "ClassDeclaration" && stmt.id?.name) {
            namesForChildren.add(stmt.id.name);
          } else if (stmt?.type === "ImportDeclaration") {
            for (const spec of stmt.specifiers ?? []) {
              // ImportDefaultSpecifier, ImportNamespaceSpecifier, ImportSpecifier
              // all have `local.name` as the binding name in this module.
              if (spec.local?.name) namesForChildren.add(spec.local.name);
            }
          }
        }

        for (const key of Object.keys(node)) {
          if (key === "type") continue;
          const child = node[key];
          if (Array.isArray(child)) {
            for (const c of child) visitNode(c, namesForChildren);
          } else if (child && typeof child === "object" && child.type) {
            visitNode(child, namesForChildren);
          }
        }
        return;
      }

      // Build the ancestor name set visible inside this function:
      // everything the parent saw, plus this function's own params.
      const namesForBody = new Set(ancestorNames);
      for (const p of node.params ?? []) collectPatternNames(p, namesForBody);

      // Check whether the body has the 'use server' directive.
      const bodyStmts: any[] = node.body?.type === "BlockStatement" ? node.body.body : [];
      const isServerFn = hasUseServerDirective(bodyStmts);

      if (isServerFn) {
        // Collect ALL variables declared anywhere in this function body.
        // This includes direct bodyStmts, but also for...of/for...in loop
        // variables, declarations inside if/try/while blocks, etc.
        // periscopic puts these in the BlockStatement scope (not the function
        // scope), so they get mis-classified as closure vars from the outer scope.
        // We use collectAllDeclaredNames (recursive, crosses blocks, stops at
        // nested function bodies) to catch every possible declaration site.
        const localDecls = new Set<string>();
        collectAllDeclaredNames(node.body, localDecls);

        // Find collisions: local decls that shadow a name from ancestor scopes.
        // collisionRenames maps original name → chosen rename target, taking
        // into account that `__local_${name}` may itself already be declared
        // (e.g. the user wrote `const __local_cookies = ...`).  In that case
        // we try `__local_0_${name}`, `__local_1_${name}`, … until we find a
        // free name.  This prevents a secondary collision.
        const collisionRenames = new Map<string, string>();
        for (const name of localDecls) {
          if (namesForBody.has(name)) {
            let to = `__local_${name}`;
            let suffix = 0;
            while (localDecls.has(to) || namesForBody.has(to)) {
              to = `__local_${suffix}_${name}`;
              suffix++;
            }
            collisionRenames.set(name, to);
          }
        }

        if (collisionRenames.size > 0) {
          for (const [name, to] of collisionRenames) {
            renamingWalk(node.body, name, to);
          }
          changed = true;
        }

        // Build the ancestor set for children of this server function.
        // Colliding names have been renamed in this body, e.g. `cookies` →
        // `__local_cookies`.  The original name no longer exists as a binding
        // in this scope, so we must remove it from the set and add the renamed
        // version instead.  Leaving the original name in would cause nested
        // server functions to see it as an ancestor binding and spuriously flag
        // their own independent `const cookies` as a collision.
        const namesForChildren = new Set(namesForBody);
        for (const name of localDecls) {
          if (collisionRenames.has(name)) {
            namesForChildren.delete(name);
            namesForChildren.add(collisionRenames.get(name)!);
          } else {
            namesForChildren.add(name);
          }
        }

        // Recurse into children — nested 'use server' functions must be visited.
        // Skip node.body itself (already handled by renamingWalk above for
        // collisions); we recurse into each statement individually so that
        // nested functions inside the body get their own visitNode pass with
        // the correct ancestorNames.
        for (const stmt of bodyStmts) {
          visitNode(stmt, namesForChildren);
        }
        // Also visit params (they can contain default expressions with closures)
        for (const p of node.params ?? []) visitNode(p, ancestorNames);
        return;
      }

      // Not a server function — build the ancestor set for nested functions:
      //   - var declarations anywhere in this function body (function-scoped)
      //   - FunctionDeclaration names anywhere in this function body
      //   - let/const only from the top-level statements of this function body
      //     (block-scoped — not visible to nested fns in sibling blocks)
      const namesForChildren = new Set(namesForBody);
      collectFunctionScopedNames(node.body, namesForChildren);
      for (const stmt of bodyStmts) {
        if (stmt?.type === "VariableDeclaration" && stmt.kind !== "var") {
          for (const decl of stmt.declarations) collectPatternNames(decl.id, namesForChildren);
        }
      }

      for (const key of Object.keys(node)) {
        if (key === "type") continue;
        const child = node[key];
        if (Array.isArray(child)) {
          for (const c of child) visitNode(c, namesForChildren);
        } else if (child && typeof child === "object" && child.type) {
          visitNode(child, namesForChildren);
        }
      }
    }

    // Walk an AST subtree renaming all variable-reference Identifier nodes
    // matching `from` to `to`.
    //
    // Correctness rules:
    //   - Non-computed MemberExpression.property is NOT a variable reference
    //   - Non-computed Property.key is NOT a variable reference
    //   - Shorthand Property { x } must be expanded to { x: __local_x }
    //   - A nested function that re-declares `from` in its params OR anywhere
    //     in its body via var/const/let (including inside control flow) is a
    //     new binding — stop descending into it
    //   - Never call s.update() on the same source range twice
    //
    // `parent` is the direct parent AST node, used to detect property contexts.
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    function renamingWalk(node: any, from: string, to: string, parent?: any) {
      if (!node || typeof node !== "object") return;

      if (node.type === "Identifier" && node.name === from) {
        // Non-computed member expression property: obj.cookies — not a ref
        if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) {
          return;
        }

        // Non-computed property key in an object literal
        if (parent?.type === "Property" && parent.key === node && !parent.computed) {
          if (parent.shorthand) {
            // { cookies } — key and value are the same AST node.
            // Expand to { cookies: __local_cookies } by rewriting at the key
            // visit; skip the value visit via the guard below.
            const rangeKey = `${node.start}:${node.end}`;
            if (!renamedRanges.has(rangeKey)) {
              renamedRanges.add(rangeKey);
              s.update(node.start, node.end, `${from}: ${to}`);
            }
          }
          // Either way, key is not a variable reference — do not rename it.
          return;
        }

        // Value side of a shorthand property — same node as key, already handled
        if (parent?.type === "Property" && parent.shorthand && parent.value === node) {
          return;
        }

        // LabeledStatement label: `cookies: for (...)` — not a variable reference
        if (parent?.type === "LabeledStatement" && parent.label === node) {
          return;
        }

        // break/continue label: `break cookies` / `continue cookies` — not a variable reference
        if (
          (parent?.type === "BreakStatement" || parent?.type === "ContinueStatement") &&
          parent.label === node
        ) {
          return;
        }

        const rangeKey = `${node.start}:${node.end}`;
        if (!renamedRanges.has(rangeKey)) {
          renamedRanges.add(rangeKey);
          s.update(node.start, node.end, to);
        }
        return;
      }

      // For nested function nodes, check whether they re-declare `from`.
      // If they do, stop — the name in that nested scope is a different binding.
      // We must check ALL var declarations anywhere in the body (var hoists),
      // not just top-level statements.
      if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
      ) {
        const nestedDecls = new Set<string>();
        // Params
        for (const p of node.params ?? []) collectPatternNames(p, nestedDecls);
        // Recursively find all var/const/let declarations in the body,
        // including those nested inside if/for/while/etc.
        collectAllDeclaredNames(node.body, nestedDecls);
        if (nestedDecls.has(from)) return;

        // Also stop at nested 'use server' functions — visitNode will handle them
        // independently with the correct collision set, preventing double-rewrites.
        if (node.body?.type === "BlockStatement" && hasUseServerDirective(node.body.body)) {
          return;
        }
      }

      for (const key of Object.keys(node)) {
        if (key === "type" || key === "start" || key === "end") continue;
        const child = node[key];
        if (Array.isArray(child)) {
          for (const c of child) renamingWalk(c, from, to, node);
        } else if (child && typeof child === "object" && child.type) {
          renamingWalk(child, from, to, node);
        }
      }
    }

    // Collect names that are visible at function scope from a given subtree.
    //
    // Two separate helpers with different traversal rules:
    //
    //   collectFunctionScopedNames(node, names)
    //     Collects `var` declarations and `FunctionDeclaration` names anywhere
    //     in the subtree, crossing block boundaries (if/for/while/try/catch)
    //     but NOT crossing nested function bodies.  `let`/`const` in nested
    //     blocks are intentionally skipped — they are block-scoped and not
    //     visible outside that block.
    //     Use this when building ancestorNames for nested functions.
    //
    //   collectAllDeclaredNames(node, names)
    //     Collects ALL var/let/const declarations anywhere in the subtree,
    //     crossing block boundaries but not nested function bodies.
    //     Used only by renamingWalk's re-declaration check, where we want to
    //     know if ANY declaration of `from` exists in a nested function's scope
    //     (params already handled separately).

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    function collectFunctionScopedNames(node: any, names: Set<string>) {
      if (!node || typeof node !== "object") return;
      // FunctionDeclaration: its name is a binding in the enclosing scope.
      // Record it, then stop — don't recurse into the body (different scope).
      if (node.type === "FunctionDeclaration") {
        if (node.id?.name) names.add(node.id.name);
        return;
      }
      // ClassDeclaration: like FunctionDeclaration, its name is a binding in
      // the enclosing scope.  Don't recurse into the body.
      if (node.type === "ClassDeclaration") {
        if (node.id?.name) names.add(node.id.name);
        return;
      }
      // FunctionExpression / ArrowFunctionExpression names are only in scope
      // inside their own body, not the enclosing scope — skip entirely.
      if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
        return;
      }
      // var declarations are function-scoped — collect them wherever they appear.
      // let/const at a nested block level are block-scoped and NOT visible to
      // sibling or outer function declarations, so skip them here.
      if (node.type === "VariableDeclaration" && node.kind === "var") {
        for (const decl of node.declarations) collectPatternNames(decl.id, names);
      }
      for (const key of Object.keys(node)) {
        if (key === "type") continue;
        const child = node[key];
        if (Array.isArray(child)) {
          for (const c of child) collectFunctionScopedNames(c, names);
        } else if (child && typeof child === "object" && child.type) {
          collectFunctionScopedNames(child, names);
        }
      }
    }

    // Collect ALL declared names (var/let/const/class/function) in a subtree,
    // crossing blocks but not nested function bodies or class bodies.
    // Used by renamingWalk's re-declaration check where any shadowing
    // declaration — regardless of kind — must stop the rename from descending
    // further, and by the server-function local-decl scan to detect all
    // possible collision sites (including class declarations in the body).
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    function collectAllDeclaredNames(node: any, names: Set<string>) {
      if (!node || typeof node !== "object") return;
      if (node.type === "VariableDeclaration") {
        for (const decl of node.declarations) collectPatternNames(decl.id, names);
      }
      // FunctionDeclaration name is a binding in the enclosing scope — record it.
      if (node.type === "FunctionDeclaration") {
        if (node.id?.name) names.add(node.id.name);
        return; // don't recurse into its body
      }
      // ClassDeclaration name is a binding in the enclosing scope — record it.
      if (node.type === "ClassDeclaration") {
        if (node.id?.name) names.add(node.id.name);
        return; // don't recurse into the class body (separate scope)
      }
      if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
        return; // different scope — stop
      }
      for (const key of Object.keys(node)) {
        if (key === "type") continue;
        const child = node[key];
        if (Array.isArray(child)) {
          for (const c of child) collectAllDeclaredNames(c, names);
        } else if (child && typeof child === "object" && child.type) {
          collectAllDeclaredNames(child, names);
        }
      }
    }

    visitNode(ast, new Set());

    if (!changed) return null;
    return { code: s.toString(), map: s.generateMap({ hires: "boundary" }) };
  },
};
