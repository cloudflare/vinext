/**
 * Oxlint plugin: no-dynamic-string-replacement.
 *
 * `String#replace` and `String#replaceAll` expand `$&`, `` $` ``, `$'`, `$n`
 * and `$<name>` in a string replacement. When runtime code splices rendered
 * output with a dynamic replacement string, data inside that string — page
 * props, request values, collected head tags — can copy other parts of the
 * document into the result, e.g. a `` $` `` in page data duplicating the whole
 * document prefix inside `__NEXT_DATA__`.
 *
 * The replacement must therefore be a static string, whose patterns are
 * visible in review, or a function, whose return value is inserted verbatim.
 */
import { definePlugin, defineRule, type ESTree, type Scope, type Variable } from "@oxlint/plugins";

const REPLACE_METHODS = new Set(["replace", "replaceAll"]);
// Global functions that are safe to pass by reference.
const GLOBAL_FUNCTIONS = new Set(["encodeURI", "encodeURIComponent"]);

function findVariable(scope: Scope | null, name: string): Variable | null {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (variable) return variable;
  }
  return null;
}

function isFunctionNode(node: ESTree.Node | null | undefined): boolean {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

/** True when the identifier is bound to a function in this file. */
function isFunctionBinding(variable: Variable): boolean {
  const definition = variable.defs[0];
  if (!definition) return false;
  if (definition.type === "FunctionName") return true;
  if (definition.type === "Variable") {
    // A `let` could be reassigned a string after its declaration.
    const declaration = definition.parent as ESTree.VariableDeclaration | null;
    const declarator = definition.node as ESTree.VariableDeclarator;
    return declaration?.kind === "const" && isFunctionNode(declarator.init);
  }
  if (definition.type === "Parameter") {
    const annotation = (definition.name as ESTree.BindingIdentifier).typeAnnotation;
    return annotation?.typeAnnotation.type === "TSFunctionType";
  }
  return false;
}

const rule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a static string or a function as the String#replace replacement so inserted data is never expanded as $-patterns.",
    },
  },
  createOnce(context) {
    function isSafeReplacement(node: ESTree.Node): boolean {
      if (node.type === "Literal") return typeof node.value === "string";
      if (node.type === "TemplateLiteral") return node.expressions.length === 0;
      if (isFunctionNode(node)) return true;
      if (node.type === "Identifier") {
        if (context.sourceCode.isGlobalReference(node)) return GLOBAL_FUNCTIONS.has(node.name);
        const variable = findVariable(context.sourceCode.getScope(node), node.name);
        return variable !== null && isFunctionBinding(variable);
      }
      return false;
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        const property = callee.property;
        const methodName = callee.computed
          ? property.type === "Literal" && typeof property.value === "string"
            ? property.value
            : null
          : property.type === "Identifier"
            ? property.name
            : null;
        if (methodName === null || !REPLACE_METHODS.has(methodName)) return;
        // String#replace takes exactly two arguments; this skips the Pages
        // router's `replace(url, as, options)` without type information.
        if (node.arguments.length !== 2) return;
        const replacement = node.arguments[1];
        if (replacement.type === "SpreadElement") return;
        if (isSafeReplacement(replacement)) return;
        context.report({
          node: replacement,
          message:
            "Pass a function (or a static string) as the replacement: String#replace expands `$&`, `` $` `` and `$'` inside dynamic strings, letting inserted data rewrite the output.",
        });
      },
    };
  },
});

export default definePlugin({
  meta: { name: "vinext-security" },
  rules: { "no-dynamic-string-replacement": rule },
});
