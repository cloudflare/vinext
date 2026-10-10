import MagicString from "magic-string";
import { parseAstAsync, type ESTree, type Plugin } from "vite";
import { stringLiteralValue, walkAst } from "./ast-utils.js";
import { magicStringTransformResult } from "./transform-result.js";

// @vitejs/plugin-rsc's `rsc:use-server` transform encrypts an inline Server
// Action's closure captures through this namespace import.
const ENCRYPTION_RUNTIME = "__vite_rsc_encryption_runtime";
const RUNTIME_METHOD_RE = /\b(?:en|de)cryptActionBoundArgs\b/;
const BOUND_ARGS_RUNTIME = "$$vinextActionBoundArgs";

function isRuntimeCall(node: ESTree.Node | null | undefined, method: string): boolean {
  return (
    node?.type === "CallExpression" &&
    node.arguments.length === 1 &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === ENCRYPTION_RUNTIME &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === method
  );
}

/** `<runtime>.registerServerReference(fn, "<key>", "<name>")` → [fn, "<key>#<name>"] */
function readServerReference(node: ESTree.Node): [string, string] | null {
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression" ||
    node.callee.computed ||
    node.callee.property.type !== "Identifier" ||
    node.callee.property.name !== "registerServerReference"
  ) {
    return null;
  }
  const [fn, key, name] = node.arguments;
  const referenceKey = stringLiteralValue(key);
  const exportName = stringLiteralValue(name);
  if (fn?.type !== "Identifier" || referenceKey === null || exportName === null) return null;
  return [fn.name, `${referenceKey}#${exportName}`];
}

/** `async function fn($$hoist_encoded, ...) { const [...] = await <decrypt>($$hoist_encoded); ...` */
function readClosureDecrypt(
  node: ESTree.Node,
): [string, ESTree.CallExpression & { callee: ESTree.MemberExpression }] | null {
  if (node.type !== "FunctionDeclaration" || !node.id) return null;
  const statement = node.body?.body[0];
  if (statement?.type !== "VariableDeclaration" || statement.declarations.length !== 1) return null;
  const init = statement.declarations[0].init;
  if (init?.type !== "AwaitExpression" || !isRuntimeCall(init.argument, "decryptActionBoundArgs")) {
    return null;
  }
  const call = init.argument as ESTree.CallExpression & { callee: ESTree.MemberExpression };
  const encoded = call.arguments[0];
  if (encoded.type !== "Identifier" || encoded.name !== "$$hoist_encoded") return null;
  return [node.id.name, call];
}

/**
 * Bind each inline Server Action's encrypted closure to its action id, like
 * Next.js. plugin-rsc encrypts captures as
 * `registerServerReference(fn, key, name).bind(null, encrypt([...captures]))`
 * and decrypts them at the top of `fn` without naming the action, so any
 * action's closure would decrypt in any other action. This rewrites both calls
 * to the vinext runtime, which seals and checks `key#name` (the `Next-Action`
 * id) with the captures. Any `*.encryptActionBoundArgs` /
 * `*.decryptActionBoundArgs` call this cannot bind fails the build rather than
 * shipping an unbound closure.
 */
export function createActionBoundArgsPlugin(options: { runtime: string }): Plugin {
  return {
    name: "vinext:action-bound-args",
    enforce: "post",
    transform: {
      filter: { code: RUNTIME_METHOD_RE },
      async handler(code, id) {
        const ast = await parseAstAsync(code);
        const output = new MagicString(code);
        const actionIds = new Map<string, string>();
        const decrypts: [string, ESTree.CallExpression & { callee: ESTree.MemberExpression }][] =
          [];
        const bound = new Set<ESTree.Node>();
        let runtimeCalls = 0;

        walkAst(ast, (node) => {
          if (
            node.type === "MemberExpression" &&
            !node.computed &&
            node.property.type === "Identifier" &&
            RUNTIME_METHOD_RE.test(node.property.name)
          ) {
            runtimeCalls++;
          }

          const reference = readServerReference(node);
          if (reference) actionIds.set(reference[0], reference[1]);

          const decrypt = readClosureDecrypt(node);
          if (decrypt) decrypts.push(decrypt);

          // `<registration>.bind(null, <encrypt>([...captures]))`
          if (
            node.type === "CallExpression" &&
            node.callee.type === "MemberExpression" &&
            !node.callee.computed &&
            node.callee.property.type === "Identifier" &&
            node.callee.property.name === "bind" &&
            node.arguments.length === 2 &&
            isRuntimeCall(node.arguments[1], "encryptActionBoundArgs")
          ) {
            const registration = readServerReference(node.callee.object);
            if (!registration) return;
            const encrypt = node.arguments[1] as ESTree.CallExpression;
            output.overwrite(
              encrypt.callee.start,
              encrypt.callee.end,
              `${BOUND_ARGS_RUNTIME}.encryptBoundArgs`,
            );
            output.appendLeft(encrypt.arguments[0].start, `${JSON.stringify(registration[1])}, `);
            bound.add(encrypt.callee);
          }
        });

        for (const [name, call] of decrypts) {
          // A hoisted action whose registration was pruned as a dead branch
          // (e.g. a `typeof window` check) never issues a closure, so bind it
          // to an id no closure is sealed for: it rejects every payload.
          const actionId = actionIds.get(name) ?? "";
          output.overwrite(
            call.callee.start,
            call.callee.end,
            `${BOUND_ARGS_RUNTIME}.decryptBoundArgs`,
          );
          output.appendLeft(call.arguments[0].start, `${JSON.stringify(actionId)}, `);
          bound.add(call.callee);
        }

        if (bound.size !== runtimeCalls) {
          this.error(
            `vinext: could not bind an inline Server Action's encrypted closure to its action id (${id}).`,
          );
        }
        if (bound.size === 0) return;
        output.prepend(
          `import * as ${BOUND_ARGS_RUNTIME} from ${JSON.stringify(options.runtime)};\n`,
        );
        return magicStringTransformResult(output, { hires: "boundary", source: id });
      },
    },
  };
}
